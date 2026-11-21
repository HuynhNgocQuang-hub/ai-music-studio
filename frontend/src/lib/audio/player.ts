import type { AudioClip, MidiNote, ProjectState } from '@/types/project';
import { resolveAudioUrl } from '@/lib/api/client';
import { getBeatsPerBar } from '@/lib/music/presets';

export type VocalABMode = 'raw' | 'dry' | 'autotune' | 'preserve' | 'enhance' | 'ai_mix';

export interface TrackChannelConfig {
  id: string;
  mute: boolean;
  solo: boolean;
  volume: number; // 0.0 .. 1.2
  pan: number; // -1.0 .. 1.0
  lowDb?: number; // -12 .. +12 dB
  midDb?: number; // -12 .. +12 dB
  highDb?: number; // -12 .. +12 dB
  reverbSend?: number; // 0.0 .. 1.0
  delaySend?: number; // 0.0 .. 1.0
}

export interface LoopRegionBars {
  startBar: number;
  endBar: number;
}

export interface TransportSnapshot {
  isPlaying: boolean;
  currentTimeSec: number;
  durationSec: number;
  bpm: number;
  loopEnabled: boolean;
  metronomeEnabled: boolean;
  loopRegionBars: LoopRegionBars | null;
  abMode: VocalABMode;
  masterPeakDb: number;
  channelPeakDb: Record<string, number>;
}

type TransportListener = (snapshot: TransportSnapshot) => void;

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Web Audio API Multi-Track Sync Engine with:
 * - Master Limiter (DynamicsCompressorNode threshold=-1.0 dBFS, ratio=20)
 * - Sample-accurate multi-track scheduling from common t=0 (<10ms sync)
 * - Instant A/B switching (Raw / Dry / Auto-Tune / AI Mix)
 * - Lightweight Web Audio MIDI synthesizer fallback for drums/bass/harmony/lead
 * - Metronome click generator
 */
export class MultiTrackAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private analyser: AnalyserNode | null = null;

  private buffers: Map<string, AudioBuffer> = new Map();
  private bufferSources: Map<string, string> = new Map();
  private lastProjectId: string | null = null;
  private channelGains: Map<string, GainNode> = new Map();
  private channelLowEq: Map<string, BiquadFilterNode> = new Map();
  private channelMidEq: Map<string, BiquadFilterNode> = new Map();
  private channelHighEq: Map<string, BiquadFilterNode> = new Map();
  private channelAnalysers: Map<string, AnalyserNode> = new Map();
  private channelPanners: Map<string, StereoPannerNode> = new Map();
  private channelReverbSends: Map<string, GainNode> = new Map();
  private channelDelaySends: Map<string, GainNode> = new Map();
  private reverbSendBus: GainNode | null = null;
  private reverbReturnGain: GainNode | null = null;
  private delaySendBus: GainNode | null = null;
  private delayReturnGain: GainNode | null = null;
  private delayLeftNode: DelayNode | null = null;
  private delayRightNode: DelayNode | null = null;
  private reverbReturnLevel = 1.0;
  private delayReturnLevel = 1.0;
  private fxBypassed = false;
  private hallImpulseBuffer: AudioBuffer | null = null;
  private activeSources: AudioBufferSourceNode[] = [];
  private activeOscillators: AudioScheduledSourceNode[] = [];
  private channelConfigs: Map<string, TrackChannelConfig> = new Map();
  private preferPreRenderedMix = false;
  private lastArrangementSig = '';
  private channelMeterScratch = new Float32Array(64);
  private masterMeterScratch = new Float32Array(256);
  private waveformCache = new WeakMap<AudioBuffer, Map<string, number[]>>();

  private isPlayingState = false;
  private startContextTime = 0;
  private pauseOffsetSec = 0;
  private durationSec = 8;
  private bpm = 100;
  private loopEnabled = false;
  private metronomeEnabled = false;
  private noiseBuffer: AudioBuffer | null = null;
  private loopRegionBars: LoopRegionBars | null = null;
  private abMode: VocalABMode = 'dry';
  private rafId: number | null = null;
  private loopTimer: number | null = null;
  private listeners: Set<TransportListener> = new Set();
  private currentProject: ProjectState | null = null;
  private metronomeTimer: number | null = null;

  private getBeatsPerBar(): number {
    return getBeatsPerBar(this.currentProject?.analysis.time_signature);
  }

  private getSecPerBeat(): number {
    return 60 / Math.max(40, Math.min(220, this.bpm || 100));
  }

  private getSecPerBar(): number {
    return this.getBeatsPerBar() * this.getSecPerBeat();
  }

  private getSyncDelaySec(): number {
    return Math.max(0.12, Math.min(0.75, 0.75 * this.getSecPerBeat()));
  }

  private createHallImpulseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.hallImpulseBuffer && this.hallImpulseBuffer.sampleRate === ctx.sampleRate) {
      return this.hallImpulseBuffer;
    }
    const sr = ctx.sampleRate;
    const len = Math.max(64, Math.floor(1.45 * sr));
    const buf = ctx.createBuffer(2, len, sr);
    let seed = 2026;
    const nextRand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 0xffffffff) * 2 - 1;
    };
    const fadeLen = Math.max(1, Math.floor(0.015 * sr));
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      let lp = 0;
      let sumSq = 0;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const env = Math.exp(-4.6 * t) * (i < fadeLen ? i / fadeLen : 1);
        lp = 0.45 * (nextRand() * env) + 0.55 * lp;
        data[i] = lp;
        sumSq += lp * lp;
      }
      const norm = sumSq > 0 ? 0.55 / Math.sqrt(sumSq) : 1;
      for (let i = 0; i < len; i++) {
        data[i] *= norm;
      }
    }
    this.hallImpulseBuffer = buf;
    return buf;
  }

  private setupFxBuses(ctx: AudioContext): void {
    if (!this.masterGain || (this.reverbSendBus && this.delaySendBus)) return;

    // Bus A: Hall Reverb Return
    this.reverbSendBus = ctx.createGain();
    const preDelay = ctx.createDelay(0.1);
    preDelay.delayTime.value = 0.018;
    const revDamp = ctx.createBiquadFilter();
    revDamp.type = 'lowpass';
    revDamp.frequency.value = 4600;
    const convolver = ctx.createConvolver();
    convolver.buffer = this.createHallImpulseBuffer(ctx);
    this.reverbReturnGain = ctx.createGain();
    this.reverbReturnGain.gain.value = this.fxBypassed ? 0 : this.reverbReturnLevel;

    this.reverbSendBus.connect(preDelay);
    preDelay.connect(revDamp);
    revDamp.connect(convolver);
    convolver.connect(this.reverbReturnGain);
    this.reverbReturnGain.connect(this.masterGain);

    // Bus B: Tempo-Synced Ping-Pong Delay Return (dotted-8th note)
    this.delaySendBus = ctx.createGain();
    const delayFilter = ctx.createBiquadFilter();
    delayFilter.type = 'lowpass';
    delayFilter.frequency.value = 3400;
    const syncSec = this.getSyncDelaySec();
    this.delayLeftNode = ctx.createDelay(1.0);
    this.delayLeftNode.delayTime.value = syncSec;
    this.delayRightNode = ctx.createDelay(1.0);
    this.delayRightNode.delayTime.value = syncSec;

    const fbLeftToRight = ctx.createGain();
    fbLeftToRight.gain.value = 0.36;
    const fbRightToLeft = ctx.createGain();
    fbRightToLeft.gain.value = 0.32;
    const panLeft = ctx.createStereoPanner();
    panLeft.pan.value = -0.55;
    const panRight = ctx.createStereoPanner();
    panRight.pan.value = 0.55;
    this.delayReturnGain = ctx.createGain();
    this.delayReturnGain.gain.value = this.fxBypassed ? 0 : this.delayReturnLevel;

    this.delaySendBus.connect(delayFilter);
    delayFilter.connect(this.delayLeftNode);
    this.delayLeftNode.connect(fbLeftToRight);
    fbLeftToRight.connect(this.delayRightNode);
    this.delayRightNode.connect(fbRightToLeft);
    fbRightToLeft.connect(this.delayLeftNode);

    this.delayLeftNode.connect(panLeft);
    this.delayRightNode.connect(panRight);
    panLeft.connect(this.delayReturnGain);
    panRight.connect(this.delayReturnGain);
    this.delayReturnGain.connect(this.masterGain);
  }

  private getActiveLoopBoundsSec(): { startSec: number; endSec: number } {
    if (!this.loopRegionBars) {
      return { startSec: 0, endSec: this.durationSec };
    }
    const secPerBar = this.getSecPerBar();
    const startSec = Math.max(0, Math.min(this.durationSec - 0.1, (this.loopRegionBars.startBar - 1) * secPerBar));
    const rawEnd = (this.loopRegionBars.endBar - 1) * secPerBar;
    const endSec = Math.max(startSec + 0.1, Math.min(this.durationSec, rawEnd));
    return { startSec, endSec };
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();

      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.95;

      // Hard brickwall-style Master Limiter <= -1.0 dBFS (SRS FR-STUDIO)
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1.0;
      this.limiter.knee.value = 0.0;
      this.limiter.ratio.value = 20.0;
      this.limiter.attack.value = 0.001;
      this.limiter.release.value = 0.05;

      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;

      this.masterGain.connect(this.limiter);
      this.limiter.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
      this.setupFxBuses(this.ctx);
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  private getOrCreateChannelNodes(trackId: string): {
    gain: GainNode;
    lowEq: BiquadFilterNode;
    midEq: BiquadFilterNode;
    highEq: BiquadFilterNode;
    panner: StereoPannerNode;
    reverbSendGain: GainNode;
    delaySendGain: GainNode;
  } {
    const ctx = this.ensureContext();
    let gain = this.channelGains.get(trackId);
    let lowEq = this.channelLowEq.get(trackId);
    let midEq = this.channelMidEq.get(trackId);
    let highEq = this.channelHighEq.get(trackId);
    let analyser = this.channelAnalysers.get(trackId);
    let panner = this.channelPanners.get(trackId);
    let reverbSendGain = this.channelReverbSends.get(trackId);
    let delaySendGain = this.channelDelaySends.get(trackId);

    if (
      !gain ||
      !lowEq ||
      !midEq ||
      !highEq ||
      !analyser ||
      !panner ||
      !reverbSendGain ||
      !delaySendGain
    ) {
      gain = ctx.createGain();
      lowEq = ctx.createBiquadFilter();
      lowEq.type = 'lowshelf';
      lowEq.frequency.value = 110;

      midEq = ctx.createBiquadFilter();
      midEq.type = 'peaking';
      midEq.frequency.value = 1000;
      midEq.Q.value = 0.9;

      highEq = ctx.createBiquadFilter();
      highEq.type = 'highshelf';
      highEq.frequency.value = 6500;

      analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      panner = ctx.createStereoPanner();
      reverbSendGain = ctx.createGain();
      reverbSendGain.gain.value = 0;
      delaySendGain = ctx.createGain();
      delaySendGain.gain.value = 0;

      gain.connect(lowEq);
      lowEq.connect(midEq);
      midEq.connect(highEq);
      highEq.connect(analyser);
      analyser.connect(panner);
      panner.connect(this.masterGain!);
      panner.connect(reverbSendGain);
      reverbSendGain.connect(this.reverbSendBus!);
      panner.connect(delaySendGain);
      delaySendGain.connect(this.delaySendBus!);

      this.channelGains.set(trackId, gain);
      this.channelLowEq.set(trackId, lowEq);
      this.channelMidEq.set(trackId, midEq);
      this.channelHighEq.set(trackId, highEq);
      this.channelAnalysers.set(trackId, analyser);
      this.channelPanners.set(trackId, panner);
      this.channelReverbSends.set(trackId, reverbSendGain);
      this.channelDelaySends.set(trackId, delaySendGain);
    }
    return { gain, lowEq, midEq, highEq, panner, reverbSendGain, delaySendGain };
  }

  public subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }

  public getSnapshot(): TransportSnapshot {
    return {
      isPlaying: this.isPlayingState,
      currentTimeSec: this.getCurrentTimeSec(),
      durationSec: this.durationSec,
      bpm: this.bpm,
      loopEnabled: this.loopEnabled,
      metronomeEnabled: this.metronomeEnabled,
      loopRegionBars: this.loopRegionBars,
      abMode: this.abMode,
      masterPeakDb: this.measureMasterPeakDb(),
      channelPeakDb: this.measureAllChannelPeaksDb(),
    };
  }

  public setMetronomeEnabled(enabled: boolean): void {
    this.metronomeEnabled = enabled;
    if (this.isPlayingState) {
      const cur = this.getCurrentTimeSec();
      this.stopSourcesOnly();
      this.startFromOffset(cur);
    } else {
      this.emit();
    }
  }

  public getCurrentTimeSec(): number {
    if (!this.isPlayingState || !this.ctx) {
      return this.pauseOffsetSec;
    }
    const elapsed = this.ctx.currentTime - this.startContextTime;
    if (this.loopEnabled && this.durationSec > 0) {
      const { startSec, endSec } = this.getActiveLoopBoundsSec();
      const span = Math.max(0.05, endSec - startSec);
      if (elapsed >= startSec) {
        return startSec + ((elapsed - startSec) % span);
      }
      return Math.max(0, elapsed);
    }
    return Math.min(elapsed, this.durationSec);
  }

  private measureMasterPeakDb(): number {
    if (!this.analyser || !this.isPlayingState) return -60;
    if (this.masterMeterScratch.length !== this.analyser.fftSize) {
      this.masterMeterScratch = new Float32Array(this.analyser.fftSize);
    }
    this.analyser.getFloatTimeDomainData(this.masterMeterScratch);
    let peak = 0;
    for (let i = 0; i < this.masterMeterScratch.length; i++) {
      const abs = Math.abs(this.masterMeterScratch[i]);
      if (abs > peak) peak = abs;
    }
    if (peak <= 0.0001) return -60;
    const db = 20 * Math.log10(peak);
    // Clamped to reflect master limiter ceiling <= -1.0 dBFS
    return Math.min(db, -1.0);
  }

  private measureAllChannelPeaksDb(): Record<string, number> {
    const out: Record<string, number> = {};
    if (!this.isPlayingState) return out;

    for (const [trackId, analyser] of this.channelAnalysers.entries()) {
      analyser.getFloatTimeDomainData(this.channelMeterScratch);
      let peak = 0;
      for (let i = 0; i < this.channelMeterScratch.length; i++) {
        const abs = Math.abs(this.channelMeterScratch[i]);
        if (abs > peak) peak = abs;
      }
      out[trackId] = peak <= 0.0001 ? -60 : Math.min(-0.5, 20 * Math.log10(peak));
    }
    return out;
  }

  public async loadAudioFromBlob(slotKey: string, blob: Blob): Promise<AudioBuffer | null> {
    try {
      const ctx = this.ensureContext();
      const arrayBuf = await blob.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(arrayBuf);
      this.buffers.set(slotKey, audioBuf);
      this.bufferSources.set(slotKey, `blob:${Date.now()}:${blob.size}`);
      this.recomputeDuration();
      this.emit();
      return audioBuf;
    } catch {
      return null;
    }
  }

  public async loadAudioFromUrl(
    slotKey: string,
    url: string,
    cacheKey?: string
  ): Promise<AudioBuffer | null> {
    try {
      const ctx = this.ensureContext();
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return null;
      const arrayBuf = await res.arrayBuffer();
      const audioBuf = await ctx.decodeAudioData(arrayBuf);
      this.buffers.set(slotKey, audioBuf);
      this.bufferSources.set(slotKey, cacheKey || url);
      this.recomputeDuration();
      this.emit();
      return audioBuf;
    } catch {
      return null;
    }
  }

  public invalidateSlots(slots?: string[]): void {
    if (!slots) {
      this.buffers.clear();
      this.bufferSources.clear();
      return;
    }
    for (const slot of slots) {
      this.buffers.delete(slot);
      this.bufferSources.delete(slot);
    }
  }

  public hasBuffer(slotKey: string): boolean {
    return this.buffers.has(slotKey);
  }

  public async syncFromProject(
    project: ProjectState,
    options?: { forceSlots?: string[]; revisionKey?: string }
  ): Promise<void> {
    if (this.lastProjectId && this.lastProjectId !== project.project_id) {
      this.stop();
      this.invalidateSlots();
      this.channelConfigs.clear();
      this.lastArrangementSig = '';
    }
    this.lastProjectId = project.project_id;
    this.currentProject = project;
    this.bpm = project.analysis.bpm || 100;

    const nextArrangementSig = [
      project.analysis.bpm,
      project.analysis.time_signature,
      project.song_structure.total_bars,
      Object.entries(project.tracks)
        .filter(([, t]) => Boolean(t))
        .map(([id, t]) =>
          t!.type === 'audio'
            ? `${id}:a:${t!.clips
                .map(
                  (c) =>
                    `${c.id}:${c.source}:${c.start_bar}:${c.trim_start_sec}:${c.trim_end_sec ?? ''}:${c.offset_ms ?? 0}`
                )
                .join(',')}`
            : `${id}:m:${t!.instrument || ''}:${t!.notes
                .map((n) => `${n.pitch}:${n.start_beat}:${n.duration}`)
                .join(';')}`
        )
        .join('|'),
    ].join('::');
    const arrangementChanged =
      this.lastArrangementSig !== '' && this.lastArrangementSig !== nextArrangementSig;
    this.lastArrangementSig = nextArrangementSig;

    // Update channel mute/solo/volume/pan/3-band EQ/Send FX
    for (const [trackId, track] of Object.entries(project.tracks)) {
      if (!track) continue;
      this.setChannelConfig({
        id: trackId,
        mute: Boolean(track.mute),
        solo: Boolean(track.solo),
        volume: track.volume ?? 0.85,
        pan: track.pan ?? 0.0,
        lowDb: track.low_db ?? 0.0,
        midDb: track.mid_db ?? 0.0,
        highDb: track.high_db ?? 0.0,
        reverbSend: track.reverb_send ?? 0.0,
        delaySend: track.delay_send ?? 0.0,
      });
    }
    this.updateDelayTempo();

    // Fetch backend audio refs when missing, forced, or source revision changed
    const pid = project.project_id;
    const forceSet = new Set(options?.forceSlots ?? []);
    const autotuneEnabled = project.autotune_settings?.enabled !== false;
    if (!autotuneEnabled) {
      this.invalidateSlots(['autotune']);
    }

    const refs: Array<[string, string | null | undefined]> = [
      ['raw', project.audio_assets.raw_input_ref],
      ['dry', project.audio_assets.dry_denoised_ref],
      ['autotune', autotuneEnabled ? project.audio_assets.tuned_vocal_ref : null],
      ['ai_mix', project.audio_assets.rendered_mix_ref],
      ['preserve', project.audio_assets.preserve_mix_ref],
      ['enhance', project.audio_assets.enhance_mix_ref],
      ['accompaniment', project.audio_assets.accompaniment_ref],
    ];

    // Also include any custom clip sources from audio tracks (e.g. vocal overdubs, texture, or imported clips)
    const standardVocalSlotRefs = new Set([
      'vocal',
      'raw_input_ref',
      'dry_denoised_ref',
      'tuned_vocal_ref',
    ]);
    const seenSources = new Set<string>(refs.map(([, r]) => r || '').filter(Boolean));
    for (const track of Object.values(project.tracks)) {
      if (!track || track.type !== 'audio') continue;
      for (const clip of track.clips || []) {
        if (
          !clip.source ||
          clip.source.startsWith('idb://') ||
          clip.source === 'overdub' ||
          standardVocalSlotRefs.has(clip.source)
        ) {
          continue;
        }
        if (!seenSources.has(clip.source)) {
          seenSources.add(clip.source);
          refs.push([clip.source, clip.source]);
        }
      }
    }

    let reloadedForced = false;
    await Promise.all(
      refs.map(async ([slot, ref]) => {
        if (!ref) return;
        const url = resolveAudioUrl(ref, pid);
        if (!url) return;
        const cacheKey = options?.revisionKey ? `${url}#${options.revisionKey}` : url;
        const prevSource = this.bufferSources.get(slot);
        const isBlobLoaded = Boolean(prevSource && prevSource.startsWith('blob:'));
        const sourceChanged = Boolean(prevSource && !isBlobLoaded && prevSource !== cacheKey);
        const shouldLoad = forceSet.has(slot) || !this.buffers.has(slot) || sourceChanged;
        if (!shouldLoad) return;
        const buf = await this.loadAudioFromUrl(slot, url, cacheKey);
        if (buf && forceSet.has(slot)) {
          reloadedForced = true;
        }
      })
    );

    this.recomputeDuration();
    if ((reloadedForced || arrangementChanged) && this.isPlayingState) {
      const offset = this.getCurrentTimeSec();
      this.stopSourcesOnly();
      this.startFromOffset(offset);
      return;
    }
    this.emit();
  }

  private recomputeDuration(): void {
    let maxDur = 0;
    for (const buf of this.buffers.values()) {
      if (buf.duration > maxDur) maxDur = buf.duration;
    }
    if (this.currentProject) {
      const bars = this.currentProject.song_structure.total_bars || 8;
      const secPerBar = this.getSecPerBar();
      const midiDur = bars * secPerBar;
      if (midiDur > maxDur) maxDur = midiDur;

      for (const [trackId, track] of Object.entries(this.currentProject.tracks)) {
        if (!track || track.type !== 'audio') continue;
        for (const clip of track.clips || []) {
          const buf = this.resolveBufferForClip(clip, trackId);
          const clipStart = Math.max(0, (clip.start_bar - 1) * secPerBar + (clip.offset_ms ?? 0) / 1000);
          const rawEnd = clip.trim_end_sec ?? buf?.duration ?? 4;
          const clipDur = Math.max(0, rawEnd - (clip.trim_start_sec || 0));
          if (clipStart + clipDur > maxDur) maxDur = clipStart + clipDur;
        }
      }
    }
    this.durationSec = Math.max(maxDur, 4);
  }

  public getClipBufferDuration(clip: AudioClip, trackId = 'vocal'): number | null {
    const buf = this.resolveBufferForClip(clip, trackId);
    return buf ? buf.duration : null;
  }

  /**
   * Sample normalized amplitude peaks [0..1] for a given decoded AudioBuffer slice.
   * Uses a WeakMap cache keyed by buffer + slice bounds for smooth 60fps DAW rendering.
   */
  private extractBufferPeaks(
    buf: AudioBuffer,
    startSec: number,
    endSec: number,
    bucketCount = 72
  ): number[] {
    const buckets = Math.max(8, Math.min(512, Math.round(bucketCount)));
    const safeStart = Math.max(0, Math.min(buf.duration, startSec));
    const safeEnd = Math.max(safeStart + 0.05, Math.min(buf.duration, endSec));
    const cacheKey = `${safeStart.toFixed(2)}:${safeEnd.toFixed(2)}:${buckets}`;

    let bufCache = this.waveformCache.get(buf);
    if (!bufCache) {
      bufCache = new Map();
      this.waveformCache.set(buf, bufCache);
    }
    const cached = bufCache.get(cacheKey);
    if (cached) return cached;

    const data = buf.getChannelData(0);
    const totalSamples = data.length;
    const startIdx = Math.max(0, Math.floor((safeStart / buf.duration) * totalSamples));
    const endIdx = Math.min(totalSamples, Math.ceil((safeEnd / buf.duration) * totalSamples));
    const span = Math.max(1, endIdx - startIdx);
    const step = span / buckets;
    const stride = Math.max(1, Math.floor(step / 48));

    const rawPeaks = new Array<number>(buckets).fill(0);
    let maxPeak = 0.001;
    for (let b = 0; b < buckets; b++) {
      const from = startIdx + Math.floor(b * step);
      const to = Math.min(endIdx, startIdx + Math.ceil((b + 1) * step));
      let peak = 0;
      for (let i = from; i < to; i += stride) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
      rawPeaks[b] = peak;
      if (peak > maxPeak) maxPeak = peak;
    }

    const scale = maxPeak > 0.05 ? 1 / maxPeak : 1;
    const normalized = rawPeaks.map((p) => Math.max(0.06, Math.min(1, p * scale)));
    bufCache.set(cacheKey, normalized);
    return normalized;
  }

  public getWaveformPeaksForSlot(slotKey: string, bucketCount = 72): number[] | null {
    const buf = this.buffers.get(slotKey);
    if (!buf) return null;
    return this.extractBufferPeaks(buf, 0, buf.duration, bucketCount);
  }

  public getWaveformPeaksForClip(
    clip: AudioClip,
    trackId = 'vocal',
    bucketCount = 72
  ): number[] | null {
    const buf = this.resolveBufferForClip(clip, trackId);
    if (!buf) return null;
    const startSec = clip.trim_start_sec || 0;
    const endSec = clip.trim_end_sec ?? buf.duration;
    return this.extractBufferPeaks(buf, startSec, endSec, bucketCount);
  }

  private resolveBufferForClip(clip: AudioClip, trackId: string): AudioBuffer | undefined {
    const src = clip.source || '';
    if (trackId === 'vocal') {
      if (src.startsWith('idb://overdub') || clip.id.startsWith('clip_overdub_') || src === 'overdub') {
        return this.buffers.get(src) || this.buffers.get(clip.id) || this.buffers.get('overdub');
      }
      const assets = this.currentProject?.audio_assets;
      const isMainVocalSource =
        !src ||
        src === 'vocal' ||
        src === 'raw_input_ref' ||
        src === 'dry_denoised_ref' ||
        src === 'tuned_vocal_ref' ||
        src === assets?.raw_input_ref ||
        src === assets?.dry_denoised_ref ||
        src === assets?.tuned_vocal_ref;

      if (isMainVocalSource) {
        if (this.abMode === 'raw' && this.buffers.has('raw')) return this.buffers.get('raw');
        if (this.abMode === 'dry' && this.buffers.has('dry')) return this.buffers.get('dry');
        if (
          (this.abMode === 'autotune' || this.abMode === 'ai_mix') &&
          this.currentProject?.autotune_settings?.enabled !== false &&
          this.buffers.has('autotune')
        ) {
          return this.buffers.get('autotune');
        }
        const fallbackKey = this.getVocalSlot();
        return fallbackKey ? this.buffers.get(fallbackKey) : undefined;
      }
      if (this.buffers.has(src)) return this.buffers.get(src);
      if (this.buffers.has(clip.id)) return this.buffers.get(clip.id);
      return undefined;
    }

    if (this.buffers.has(src)) return this.buffers.get(src);
    if (this.buffers.has(clip.id)) return this.buffers.get(clip.id);
    return undefined;
  }

  private clampEqDb(value: number | undefined, fallback = 0): number {
    return Math.max(-12, Math.min(12, value ?? fallback));
  }

  private clampSend(value: number | undefined, fallback = 0): number {
    return Math.max(0, Math.min(1, value ?? fallback));
  }

  private updateDelayTempo(): void {
    if (!this.ctx || !this.delayLeftNode || !this.delayRightNode) return;
    const syncSec = this.getSyncDelaySec();
    const now = this.ctx.currentTime;
    this.delayLeftNode.delayTime.setTargetAtTime(syncSec, now, 0.03);
    this.delayRightNode.delayTime.setTargetAtTime(syncSec, now, 0.03);
  }

  public setChannelConfig(cfg: TrackChannelConfig): void {
    const prev = this.channelConfigs.get(cfg.id);
    this.channelConfigs.set(cfg.id, {
      ...cfg,
      lowDb: this.clampEqDb(cfg.lowDb, prev?.lowDb ?? 0),
      midDb: this.clampEqDb(cfg.midDb, prev?.midDb ?? 0),
      highDb: this.clampEqDb(cfg.highDb, prev?.highDb ?? 0),
      reverbSend: this.clampSend(cfg.reverbSend, prev?.reverbSend ?? 0),
      delaySend: this.clampSend(cfg.delaySend, prev?.delaySend ?? 0),
    });
    this.applyChannelRouting();
  }

  public setChannelEq(
    trackId: string,
    eq: { lowDb?: number; midDb?: number; highDb?: number }
  ): void {
    const prev = this.channelConfigs.get(trackId);
    this.channelConfigs.set(trackId, {
      id: trackId,
      mute: prev?.mute ?? false,
      solo: prev?.solo ?? false,
      volume: prev?.volume ?? 0.85,
      pan: prev?.pan ?? 0,
      lowDb: this.clampEqDb(eq.lowDb, prev?.lowDb ?? 0),
      midDb: this.clampEqDb(eq.midDb, prev?.midDb ?? 0),
      highDb: this.clampEqDb(eq.highDb, prev?.highDb ?? 0),
      reverbSend: this.clampSend(prev?.reverbSend, 0),
      delaySend: this.clampSend(prev?.delaySend, 0),
    });
    this.applyChannelRouting();
  }

  public setChannelSends(
    trackId: string,
    sends: { reverbSend?: number; delaySend?: number }
  ): void {
    const prev = this.channelConfigs.get(trackId);
    this.channelConfigs.set(trackId, {
      id: trackId,
      mute: prev?.mute ?? false,
      solo: prev?.solo ?? false,
      volume: prev?.volume ?? 0.85,
      pan: prev?.pan ?? 0,
      lowDb: this.clampEqDb(prev?.lowDb, 0),
      midDb: this.clampEqDb(prev?.midDb, 0),
      highDb: this.clampEqDb(prev?.highDb, 0),
      reverbSend: this.clampSend(sends.reverbSend, prev?.reverbSend ?? 0),
      delaySend: this.clampSend(sends.delaySend, prev?.delaySend ?? 0),
    });
    this.applyChannelRouting();
  }

  public setFxBusConfig(cfg: {
    reverbReturn?: number;
    delayReturn?: number;
    bypassed?: boolean;
  }): void {
    if (cfg.reverbReturn !== undefined) {
      this.reverbReturnLevel = Math.max(0, Math.min(1.2, cfg.reverbReturn));
    }
    if (cfg.delayReturn !== undefined) {
      this.delayReturnLevel = Math.max(0, Math.min(1.2, cfg.delayReturn));
    }
    if (cfg.bypassed !== undefined) {
      this.fxBypassed = cfg.bypassed;
    }
    if (this.ctx) {
      const now = this.ctx.currentTime;
      if (this.reverbReturnGain) {
        this.reverbReturnGain.gain.setTargetAtTime(
          this.fxBypassed ? 0 : this.reverbReturnLevel,
          now,
          0.02
        );
      }
      if (this.delayReturnGain) {
        this.delayReturnGain.gain.setTargetAtTime(
          this.fxBypassed ? 0 : this.delayReturnLevel,
          now,
          0.02
        );
      }
    }
  }

  private applyChannelRouting(): void {
    if (!this.ctx) return;
    const anySolo = Array.from(this.channelConfigs.values()).some((c) => c.solo);
    const now = this.ctx.currentTime;

    for (const [id, cfg] of this.channelConfigs.entries()) {
      const { gain, lowEq, midEq, highEq, panner, reverbSendGain, delaySendGain } =
        this.getOrCreateChannelNodes(id);
      const audible = !cfg.mute && (!anySolo || cfg.solo);
      const targetGain = audible ? Math.max(0, Math.min(1.2, cfg.volume)) : 0;
      gain.gain.setTargetAtTime(targetGain, now, 0.015);
      lowEq.gain.setTargetAtTime(this.clampEqDb(cfg.lowDb), now, 0.02);
      midEq.gain.setTargetAtTime(this.clampEqDb(cfg.midDb), now, 0.02);
      highEq.gain.setTargetAtTime(this.clampEqDb(cfg.highDb), now, 0.02);
      panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, cfg.pan)), now, 0.015);
      reverbSendGain.gain.setTargetAtTime(
        audible ? this.clampSend(cfg.reverbSend) * 0.55 : 0,
        now,
        0.02
      );
      delaySendGain.gain.setTargetAtTime(
        audible ? this.clampSend(cfg.delaySend) * 0.5 : 0,
        now,
        0.02
      );
    }
  }

  public setPreferPreRenderedMix(enabled: boolean): void {
    if (this.preferPreRenderedMix === enabled) return;
    this.preferPreRenderedMix = enabled;
    if (this.isPlayingState) {
      const offset = this.getCurrentTimeSec();
      this.stopSourcesOnly();
      this.startFromOffset(offset);
    } else {
      this.emit();
    }
  }

  /**
   * Instant A/B switch between Raw / Dry / Auto-Tune / AI Mix without losing playback offset.
   */
  public setABMode(mode: VocalABMode): void {
    if (this.abMode === mode) return;
    this.abMode = mode;
    if (this.isPlayingState) {
      const offset = this.getCurrentTimeSec();
      this.stopSourcesOnly();
      this.startFromOffset(offset);
    } else {
      this.emit();
    }
  }

  public setLoop(enabled: boolean): void {
    this.loopEnabled = enabled;
    if (this.isPlayingState) {
      const cur = this.getCurrentTimeSec();
      this.stopSourcesOnly();
      this.startFromOffset(cur);
    } else {
      this.emit();
    }
  }

  public setLoopRegionBars(startBar: number | null, endBar: number | null): void {
    if (startBar === null || endBar === null || endBar <= startBar) {
      this.loopRegionBars = null;
    } else {
      const clampedStart = Math.max(1, startBar);
      const clampedEnd = Math.max(clampedStart + 1, endBar);
      this.loopRegionBars = { startBar: clampedStart, endBar: clampedEnd };
    }
    if (this.isPlayingState && this.loopEnabled) {
      const cur = this.getCurrentTimeSec();
      this.stopSourcesOnly();
      this.startFromOffset(cur);
    } else {
      this.emit();
    }
  }

  public setBpm(bpm: number): void {
    const clamped = Math.max(40, Math.min(220, bpm));
    const prevSecPerBeat = this.getSecPerBeat();
    const curSec = this.getCurrentTimeSec();
    const curBeat = prevSecPerBeat > 0 ? curSec / prevSecPerBeat : 0;

    this.bpm = clamped;
    this.recomputeDuration();
    this.updateDelayTempo();

    const nextSec = Math.max(0, Math.min(this.durationSec, curBeat * this.getSecPerBeat()));
    this.pauseOffsetSec = nextSec;
    if (this.isPlayingState) {
      this.stopSourcesOnly();
      this.startFromOffset(nextSec);
    } else {
      this.emit();
    }
  }

  public play(fromSec?: number): void {
    let offset = fromSec !== undefined ? fromSec : this.pauseOffsetSec;
    if (fromSec === undefined && this.loopEnabled && this.loopRegionBars) {
      const { startSec, endSec } = this.getActiveLoopBoundsSec();
      if (offset < startSec || offset >= endSec) {
        offset = startSec;
      }
    }
    this.startFromOffset(offset);
  }

  public pause(): void {
    if (!this.isPlayingState) return;
    this.pauseOffsetSec = this.getCurrentTimeSec();
    this.isPlayingState = false;
    this.stopSourcesOnly();
    this.stopAnimationLoop();
    this.emit();
  }

  public stop(): void {
    this.isPlayingState = false;
    this.pauseOffsetSec = 0;
    this.stopSourcesOnly();
    this.stopAnimationLoop();
    this.emit();
  }

  public seek(sec: number): void {
    const clamped = Math.max(0, Math.min(sec, this.durationSec));
    this.pauseOffsetSec = clamped;
    if (this.isPlayingState) {
      this.stopSourcesOnly();
      this.startFromOffset(clamped);
    } else {
      this.emit();
    }
  }

  public seekToBar(bar: number): void {
    const sec = Math.max(0, (Math.max(1, bar) - 1) * this.getSecPerBar());
    this.seek(sec);
  }

  private startFromOffset(offsetSec: number): void {
    const ctx = this.ensureContext();
    this.stopSourcesOnly();

    const { startSec: loopStartSec, endSec: loopEndSec } = this.getActiveLoopBoundsSec();
    if (this.loopEnabled && this.loopRegionBars && loopEndSec > loopStartSec) {
      if (offsetSec < loopStartSec || offsetSec >= loopEndSec) {
        offsetSec = loopStartSec;
      }
      this.pauseOffsetSec = offsetSec;
    }

    // Common sample-accurate anchor t=0 (+25ms lookahead for <10ms sync)
    const scheduleAnchor = ctx.currentTime + 0.025;
    this.startContextTime = scheduleAnchor - offsetSec;
    this.isPlayingState = true;

    const playbackEndSec = this.loopEnabled ? loopEndSec : this.durationSec;

    const vocalClips = this.currentProject?.tracks.vocal?.clips || [];
    const textureClips = this.currentProject?.tracks.texture?.clips || [];
    const hasExplicitClips = vocalClips.length > 0 || textureClips.length > 0;
    const tracks = this.currentProject?.tracks;
    const hasMidiNotes = Boolean(
      tracks &&
        (tracks.drums?.notes?.length ||
          tracks.bass?.notes?.length ||
          tracks.harmony?.notes?.length ||
          tracks.lead?.notes?.length)
    );

    // 1. Pre-rendered full mix buffer only when CreatePage requests it; Studio DAW always uses live multi-track mixer
    const activeKey = this.pickActiveBufferKey();
    const isPreRenderedFullMix =
      this.preferPreRenderedMix &&
      (activeKey === 'preserve' ||
        activeKey === 'enhance' ||
        (activeKey === 'ai_mix' && !hasExplicitClips && this.buffers.has('ai_mix')));

    if (isPreRenderedFullMix && activeKey) {
      const fullBuf = this.buffers.get(activeKey);
      if (fullBuf && offsetSec < Math.min(fullBuf.duration, playbackEndSec)) {
        const src = ctx.createBufferSource();
        src.buffer = fullBuf;
        src.loop = false;
        const { gain } = this.getOrCreateChannelNodes('vocal');
        src.connect(gain);
        const playDur = Math.max(0.01, Math.min(fullBuf.duration, playbackEndSec) - offsetSec);
        src.start(scheduleAnchor, offsetSec, playDur);
        this.activeSources.push(src);
      }
    } else if (this.currentProject) {
      // 1a. Vocal track: schedule every AudioClip when present, otherwise fallback to active vocal slot
      if (vocalClips.length > 0) {
        for (const clip of vocalClips) {
          this.scheduleAudioClip(ctx, clip, 'vocal', scheduleAnchor, offsetSec, playbackEndSec);
        }
      } else {
        const vocalKey = this.pickActiveVocalBufferKey();
        const vocalBuf = vocalKey ? this.buffers.get(vocalKey) : undefined;
        if (vocalBuf && offsetSec < Math.min(vocalBuf.duration, playbackEndSec)) {
          const src = ctx.createBufferSource();
          src.buffer = vocalBuf;
          src.loop = false;
          const { gain } = this.getOrCreateChannelNodes('vocal');
          src.connect(gain);
          const playDur = Math.max(0.01, Math.min(vocalBuf.duration, playbackEndSec) - offsetSec);
          src.start(scheduleAnchor, offsetSec, playDur);
          this.activeSources.push(src);
        }
      }

      // 1b. Texture & any additional audio tracks: schedule every AudioClip
      for (const [trackId, track] of Object.entries(this.currentProject.tracks)) {
        if (!track || track.type !== 'audio' || trackId === 'vocal') continue;
        for (const clip of track.clips || []) {
          this.scheduleAudioClip(ctx, clip, trackId, scheduleAnchor, offsetSec, playbackEndSec);
        }
      }

      // 2. Live multi-track MIDI synth in Studio DAW; pre-rendered accompaniment when CreatePage prefers it or no MIDI notes exist
      if (
        (this.preferPreRenderedMix || !hasMidiNotes) &&
        (this.abMode === 'dry' || this.abMode === 'autotune' || this.abMode === 'raw') &&
        this.buffers.has('accompaniment')
      ) {
        const accBuf = this.buffers.get('accompaniment')!;
        if (offsetSec < Math.min(accBuf.duration, playbackEndSec)) {
          const accSrc = ctx.createBufferSource();
          accSrc.buffer = accBuf;
          accSrc.loop = false;
          const { gain } = this.getOrCreateChannelNodes('harmony');
          accSrc.connect(gain);
          const playDur = Math.max(0.01, Math.min(accBuf.duration, playbackEndSec) - offsetSec);
          accSrc.start(scheduleAnchor, offsetSec, playDur);
          this.activeSources.push(accSrc);
        }
      } else {
        this.scheduleMidiTracks(scheduleAnchor, offsetSec, playbackEndSec);
      }
    }

    if (this.metronomeEnabled) {
      this.scheduleTransportMetronome(ctx, scheduleAnchor, offsetSec, playbackEndSec);
    }

    // Re-trigger loop boundary seamlessly at loopEndSec -> loopStartSec
    if (this.loopEnabled && playbackEndSec > loopStartSec) {
      const remainingMs = Math.max(30, (playbackEndSec - offsetSec) * 1000);
      this.loopTimer = window.setTimeout(() => {
        if (this.isPlayingState && this.loopEnabled) {
          this.startFromOffset(loopStartSec);
        }
      }, remainingMs);
    }

    this.applyChannelRouting();
    this.startAnimationLoop();
    this.emit();
  }

  private scheduleAudioClip(
    ctx: AudioContext,
    clip: AudioClip,
    trackId: string,
    anchorTime: number,
    offsetSec: number,
    playbackEndSec: number
  ): void {
    const buf = this.resolveBufferForClip(clip, trackId);
    if (!buf) return;

    const secPerBar = this.getSecPerBar();
    const trimStart = Math.max(0, Math.min(buf.duration, clip.trim_start_sec || 0));
    const trimEnd =
      clip.trim_end_sec !== undefined && clip.trim_end_sec !== null
        ? Math.min(buf.duration, Math.max(trimStart, clip.trim_end_sec))
        : buf.duration;
    const segDur = trimEnd - trimStart;
    if (segDur <= 0.01) return;

    const rawTimelineStart =
      (Math.max(1, clip.start_bar || 1) - 1) * secPerBar + (clip.offset_ms ?? 0) / 1000;

    let effectiveTimelineStart = rawTimelineStart;
    let effectiveBufStart = trimStart;
    let effectiveDur = segDur;

    if (rawTimelineStart < 0) {
      const skip = -rawTimelineStart;
      effectiveTimelineStart = 0;
      effectiveBufStart += skip;
      effectiveDur -= skip;
    }

    if (effectiveDur <= 0.01 || effectiveTimelineStart >= playbackEndSec) return;

    const clippedDur = Math.min(effectiveDur, playbackEndSec - effectiveTimelineStart);
    if (effectiveTimelineStart + clippedDur <= offsetSec) return;

    const alreadyElapsed = Math.max(0, offsetSec - effectiveTimelineStart);
    const playWhen = anchorTime + Math.max(0, effectiveTimelineStart - offsetSec);
    const bufOffset = effectiveBufStart + alreadyElapsed;
    const playDur = clippedDur - alreadyElapsed;
    if (playDur <= 0.01 || bufOffset >= trimEnd) return;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = false;

    const clipGain = ctx.createGain();
    const fadeInSec = Math.min(effectiveDur * 0.5, Math.max(0, (clip.fade_in_ms ?? 0) / 1000));
    const fadeOutSec = Math.min(effectiveDur * 0.5, Math.max(0, (clip.fade_out_ms ?? 0) / 1000));
    const fullClipEndRel = effectiveDur;
    const fadeOutStartRel = Math.max(fadeInSec, fullClipEndRel - fadeOutSec);

    // Compute exact gain envelope accounting for playhead offset inside the clip
    const startGain =
      fadeInSec > 0 && alreadyElapsed < fadeInSec
        ? Math.max(0.0001, alreadyElapsed / fadeInSec)
        : alreadyElapsed > fadeOutStartRel && fadeOutSec > 0
          ? Math.max(0.0001, (fullClipEndRel - alreadyElapsed) / fadeOutSec)
          : 1.0;

    clipGain.gain.setValueAtTime(startGain, playWhen);
    if (fadeInSec > 0 && alreadyElapsed < fadeInSec) {
      clipGain.gain.linearRampToValueAtTime(1.0, playWhen + (fadeInSec - alreadyElapsed));
    }
    const fadeOutAt = playWhen + (fadeOutStartRel - alreadyElapsed);
    const clipEndAt = playWhen + playDur;
    if (fadeOutSec > 0 && fadeOutAt < clipEndAt) {
      if (fadeOutAt > playWhen) {
        clipGain.gain.setValueAtTime(1.0, fadeOutAt);
      }
      clipGain.gain.linearRampToValueAtTime(0.0001, clipEndAt);
    }

    const { gain } = this.getOrCreateChannelNodes(trackId);
    src.connect(clipGain);
    clipGain.connect(gain);
    src.start(playWhen, bufOffset, playDur);
    this.activeSources.push(src);
  }

  private getVocalSlot(): string | null {
    const autotuneEnabled = this.currentProject?.autotune_settings?.enabled !== false;
    if (this.abMode === 'raw' && this.buffers.has('raw')) return 'raw';
    if (this.abMode === 'dry' && this.buffers.has('dry')) return 'dry';
    if (
      autotuneEnabled &&
      (this.abMode === 'autotune' || this.abMode === 'ai_mix') &&
      this.buffers.has('autotune')
    ) {
      return 'autotune';
    }
    if (autotuneEnabled && this.buffers.has('autotune')) return 'autotune';
    if (this.buffers.has('dry')) return 'dry';
    if (this.buffers.has('raw')) return 'raw';
    return null;
  }

  private pickActiveVocalBufferKey(): string | null {
    return this.getVocalSlot();
  }

  private pickActiveBufferKey(): string | null {
    const autotuneEnabled = this.currentProject?.autotune_settings?.enabled !== false;
    if (this.abMode === 'preserve') {
      if (this.buffers.has('preserve')) return 'preserve';
      if (autotuneEnabled && this.buffers.has('autotune')) return 'autotune';
    }
    if (this.abMode === 'enhance') {
      if (this.buffers.has('enhance')) return 'enhance';
      if (autotuneEnabled && this.buffers.has('autotune')) return 'autotune';
    }
    if (this.abMode === 'ai_mix') {
      if (this.buffers.has('ai_mix')) return 'ai_mix';
      if (autotuneEnabled && this.buffers.has('autotune')) return 'autotune';
    }
    return this.getVocalSlot();
  }

  private getOrCreateNoiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer && this.noiseBuffer.sampleRate === ctx.sampleRate) {
      return this.noiseBuffer;
    }
    const len = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buf;
    return buf;
  }

  private static readonly MELODIC_PROFILES: Record<
    string,
    { wave: OscillatorType; attack: number; releaseRatio: number; cutoffHz: number; q: number }
  > = {
    finger_bass: { wave: 'triangle', attack: 0.008, releaseRatio: 0.85, cutoffHz: 850, q: 1.4 },
    synth_bass: { wave: 'sawtooth', attack: 0.006, releaseRatio: 0.9, cutoffHz: 620, q: 3.0 },
    upright_bass: { wave: 'triangle', attack: 0.015, releaseRatio: 0.72, cutoffHz: 460, q: 1.0 },
    grand_piano: { wave: 'triangle', attack: 0.008, releaseRatio: 0.9, cutoffHz: 2800, q: 0.8 },
    acoustic_guitar: { wave: 'triangle', attack: 0.005, releaseRatio: 0.78, cutoffHz: 2400, q: 0.9 },
    warm_pad: { wave: 'sawtooth', attack: 0.08, releaseRatio: 1.0, cutoffHz: 950, q: 0.7 },
    electric_piano: { wave: 'sine', attack: 0.01, releaseRatio: 0.92, cutoffHz: 2200, q: 1.0 },
    synth_lead: { wave: 'sawtooth', attack: 0.012, releaseRatio: 0.95, cutoffHz: 3200, q: 1.8 },
    flute: { wave: 'sine', attack: 0.045, releaseRatio: 0.92, cutoffHz: 1800, q: 0.6 },
  };

  private triggerMelodicNote(
    ctx: AudioContext,
    trackId: string,
    instrument: string | undefined,
    pitch: number,
    playAt: number,
    durSec: number,
    velGain: number,
    dest: GainNode,
    trackOsc: boolean
  ): void {
    const defaultKey =
      trackId === 'bass' ? 'finger_bass' : trackId === 'lead' ? 'synth_lead' : 'grand_piano';
    const profile =
      (instrument && MultiTrackAudioEngine.MELODIC_PROFILES[instrument]) ||
      MultiTrackAudioEngine.MELODIC_PROFILES[defaultKey];

    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();

    osc.type = profile.wave;
    osc.frequency.value = midiToFreq(pitch);
    filter.type = 'lowpass';
    filter.frequency.value = profile.cutoffHz;
    filter.Q.value = profile.q;

    const safeDur = Math.max(0.05, durSec);
    const attack = Math.min(profile.attack, safeDur * 0.45);
    const releaseEnd = Math.max(playAt + attack + 0.03, playAt + safeDur * profile.releaseRatio);

    env.gain.setValueAtTime(0.0001, playAt);
    env.gain.linearRampToValueAtTime(Math.max(0.001, velGain), playAt + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, releaseEnd);

    osc.connect(filter);
    filter.connect(env);
    env.connect(dest);
    osc.start(playAt);
    osc.stop(releaseEnd + 0.02);
    if (trackOsc) {
      this.activeOscillators.push(osc);
    }
  }

  private triggerDrumVoice(
    ctx: AudioContext,
    pitch: number,
    when: number,
    velGain: number,
    dest: GainNode,
    instrument = 'acoustic_kit'
  ): void {
    const kit = (instrument || 'acoustic_kit').toLowerCase();
    const is808 = kit === 'electronic_808';
    const isLofi = kit === 'lofi_kit';

    if (pitch <= 37) {
      // Kick: deep sub-tail for 808, warm thud for lo-fi, balanced punch for acoustic
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      const startHz = is808 ? 135 : isLofi ? 122 : 155;
      const endHz = is808 ? 36 : isLofi ? 48 : 42;
      const pitchDur = is808 ? 0.17 : isLofi ? 0.09 : 0.11;
      const decayDur = is808 ? 0.4 : isLofi ? 0.19 : 0.24;
      const peakGain = velGain * (is808 ? 1.55 : isLofi ? 1.25 : 1.45);

      osc.frequency.setValueAtTime(startHz, when);
      osc.frequency.exponentialRampToValueAtTime(endHz, when + pitchDur);
      env.gain.setValueAtTime(peakGain, when);
      env.gain.exponentialRampToValueAtTime(0.0001, when + decayDur);
      osc.connect(env);
      env.connect(dest);
      osc.start(when);
      osc.stop(when + decayDur + 0.02);
      this.activeOscillators.push(osc);
      return;
    }

    if (pitch >= 42) {
      // Closed / Open Hi-Hat & Ride shaped by drum kit timbre
      const noise = ctx.createBufferSource();
      noise.buffer = this.getOrCreateNoiseBuffer(ctx);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = is808 ? 7800 : isLofi ? 4800 : 6500;
      const env = ctx.createGain();
      const dur = isLofi ? (pitch >= 45 ? 0.16 : 0.05) : pitch >= 45 ? 0.22 : 0.065;
      const hatGain = velGain * (isLofi ? 0.48 : is808 ? 0.78 : 0.72);
      env.gain.setValueAtTime(hatGain, when);
      env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      noise.connect(hp);
      hp.connect(env);
      env.connect(dest);
      noise.start(when);
      noise.stop(when + dur + 0.02);
      this.activeSources.push(noise);
      return;
    }

    // Snare / Clap: tonal body + bandpassed noise snap
    const bodyOsc = ctx.createOscillator();
    const bodyEnv = ctx.createGain();
    bodyOsc.type = 'triangle';
    bodyOsc.frequency.setValueAtTime(is808 ? 220 : isLofi ? 170 : 195, when);
    bodyOsc.frequency.exponentialRampToValueAtTime(is808 ? 125 : isLofi ? 105 : 115, when + 0.08);
    bodyEnv.gain.setValueAtTime(velGain * (isLofi ? 0.65 : 0.8), when);
    bodyEnv.gain.exponentialRampToValueAtTime(0.0001, when + 0.1);
    bodyOsc.connect(bodyEnv);
    bodyEnv.connect(dest);
    bodyOsc.start(when);
    bodyOsc.stop(when + 0.12);
    this.activeOscillators.push(bodyOsc);

    const snareNoise = ctx.createBufferSource();
    snareNoise.buffer = this.getOrCreateNoiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value =
      pitch === 39 ? (isLofi ? 1350 : 1800) : is808 ? 3100 : isLofi ? 1600 : 2600;
    const noiseEnv = ctx.createGain();
    const noiseDur = isLofi ? 0.11 : 0.15;
    noiseEnv.gain.setValueAtTime(velGain * (isLofi ? 0.75 : 0.95), when);
    noiseEnv.gain.exponentialRampToValueAtTime(0.0001, when + noiseDur);
    snareNoise.connect(bp);
    bp.connect(noiseEnv);
    noiseEnv.connect(dest);
    snareNoise.start(when);
    snareNoise.stop(when + noiseDur + 0.02);
    this.activeSources.push(snareNoise);
  }

  private scheduleTransportMetronome(
    ctx: AudioContext,
    anchorTime: number,
    offsetSec: number,
    maxEndSec: number
  ): void {
    const secPerBeat = this.getSecPerBeat();
    const beatsPerBar = this.getBeatsPerBar();
    const firstBeat = Math.ceil((offsetSec - 0.001) / secPerBeat);
    const lastBeat = Math.floor((maxEndSec - 0.01) / secPerBeat);

    for (let b = Math.max(0, firstBeat); b <= lastBeat; b++) {
      const beatTimeSec = b * secPerBeat;
      const playAt = anchorTime + Math.max(0, beatTimeSec - offsetSec);
      const isDownbeat = b % beatsPerBar === 0;
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = isDownbeat ? 1200 : 820;
      env.gain.setValueAtTime(isDownbeat ? 0.18 : 0.1, playAt);
      env.gain.exponentialRampToValueAtTime(0.0001, playAt + 0.045);
      osc.connect(env);
      env.connect(this.masterGain!);
      osc.start(playAt);
      osc.stop(playAt + 0.055);
      this.activeOscillators.push(osc);
    }
  }

  private scheduleMidiTracks(anchorTime: number, offsetSec: number, maxEndSec = this.durationSec): void {
    if (!this.ctx || !this.currentProject) return;
    const secPerBeat = this.getSecPerBeat();
    const tracks = this.currentProject.tracks;

    const midiTrackIds = ['bass', 'harmony', 'lead', 'drums'] as const;

    for (const trackId of midiTrackIds) {
      const track = tracks[trackId];
      const notes: MidiNote[] = track?.notes || [];
      if (!notes.length) continue;
      const instrument = track?.instrument ?? undefined;
      const { gain } = this.getOrCreateChannelNodes(trackId);

      for (const note of notes) {
        const noteStartSec = note.start_beat * secPerBeat;
        if (noteStartSec >= maxEndSec) continue;
        const rawDurSec = Math.max(0.06, note.duration * secPerBeat);
        const noteDurSec = Math.min(rawDurSec, Math.max(0.06, maxEndSec - noteStartSec));
        if (noteStartSec + noteDurSec <= offsetSec) continue;

        const alreadyIntoNote = Math.max(0, offsetSec - noteStartSec);
        const remainingDur = Math.max(0.04, noteDurSec - alreadyIntoNote);
        const playAt = anchorTime + Math.max(0, noteStartSec - offsetSec);
        const velGain = Math.min(0.28, ((note.velocity || 85) / 127) * 0.24);

        if (trackId === 'drums') {
          this.triggerDrumVoice(this.ctx, note.pitch, playAt, velGain, gain, instrument);
          continue;
        }

        this.triggerMelodicNote(
          this.ctx,
          trackId,
          instrument,
          note.pitch,
          playAt,
          remainingDur,
          velGain,
          gain,
          true
        );
      }
    }
  }

  /**
   * Immediately audition a single MIDI note (used by Piano Roll keyboard, Step Sequencer & note editing).
   */
  public auditionMidiNote(pitch: number, trackId = 'harmony'): void {
    const ctx = this.ensureContext();
    const now = ctx.currentTime;
    const { gain } = this.getOrCreateChannelNodes(trackId);
    const track = this.currentProject?.tracks[trackId];
    const instrument = track && track.type === 'midi' ? track.instrument ?? undefined : undefined;

    if (trackId === 'drums') {
      this.triggerDrumVoice(ctx, pitch, now, 0.25, gain, instrument);
      return;
    }

    this.triggerMelodicNote(ctx, trackId, instrument, pitch, now, 0.35, 0.22, gain, false);
  }

  private stopSourcesOnly(): void {
    if (this.loopTimer !== null) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    for (const src of this.activeSources) {
      try {
        src.stop();
        src.disconnect();
      } catch {
        // already stopped
      }
    }
    this.activeSources = [];

    for (const osc of this.activeOscillators) {
      try {
        osc.stop();
        osc.disconnect();
      } catch {
        // already stopped
      }
    }
    this.activeOscillators = [];
  }

  private startAnimationLoop(): void {
    this.stopAnimationLoop();
    const tick = () => {
      if (!this.isPlayingState) return;
      const cur = this.getCurrentTimeSec();
      if (!this.loopEnabled && cur >= this.durationSec) {
        this.stop();
        return;
      }
      this.emit();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopAnimationLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Play a short metronome click (accent on downbeat).
   */
  public playClick(accent = false): void {
    const ctx = this.ensureContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = accent ? 1100 : 800;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.22, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
    osc.connect(gain);
    gain.connect(this.masterGain!);
    osc.start(now);
    osc.stop(now + 0.06);
  }

  public startMetronome(bpm: number, beatsPerBar = 4): void {
    this.stopMetronome();
    let beatIdx = 0;
    const intervalMs = (60 / Math.max(40, Math.min(220, bpm))) * 1000;
    this.playClick(true);
    beatIdx = 1;
    this.metronomeTimer = window.setInterval(() => {
      this.playClick(beatIdx % beatsPerBar === 0);
      beatIdx++;
    }, intervalMs);
  }

  public stopMetronome(): void {
    if (this.metronomeTimer !== null) {
      clearInterval(this.metronomeTimer);
      this.metronomeTimer = null;
    }
  }

  public dispose(): void {
    this.stop();
    this.stopMetronome();
    this.channelAnalysers.clear();
    this.channelGains.clear();
    this.channelLowEq.clear();
    this.channelMidEq.clear();
    this.channelHighEq.clear();
    this.channelPanners.clear();
    this.channelReverbSends.clear();
    this.channelDelaySends.clear();
    this.reverbSendBus = null;
    this.reverbReturnGain = null;
    this.delaySendBus = null;
    this.delayReturnGain = null;
    this.delayLeftNode = null;
    this.delayRightNode = null;
    this.hallImpulseBuffer = null;
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}

// Singleton instance so navigating /create -> /studio/[id] keeps audio state seamless
let sharedEngine: MultiTrackAudioEngine | null = null;

export function getAudioEngine(): MultiTrackAudioEngine {
  if (!sharedEngine) {
    sharedEngine = new MultiTrackAudioEngine();
  }
  return sharedEngine;
}

function writeAsciiString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Decode a browser MediaRecorder blob (e.g. audio/webm or audio/ogg) and encode it
 * as a standard Mono 16-bit PCM WAV Blob accepted by the backend audio validator.
 */
export async function encodeBlobToWav(blob: Blob): Promise<Blob> {
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const sampleRate = audioBuffer.sampleRate;
    const numSamples = audioBuffer.length;
    const numChannels = audioBuffer.numberOfChannels;

    // Mix down to mono float32
    const mono = new Float32Array(numSamples);
    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < numSamples; i++) {
        mono[i] += channelData[i] / numChannels;
      }
    }

    const dataSize = numSamples * 2; // 16-bit PCM
    const wavBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(wavBuffer);

    writeAsciiString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAsciiString(view, 8, 'WAVE');
    writeAsciiString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // AudioFormat = 1 (PCM)
    view.setUint16(22, 1, true); // NumChannels = 1 (Mono)
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // ByteRate
    view.setUint16(32, 2, true); // BlockAlign
    view.setUint16(34, 16, true); // BitsPerSample
    writeAsciiString(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      const sample = Math.max(-1, Math.min(1, mono[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }

    return new Blob([wavBuffer], { type: 'audio/wav' });
  } finally {
    await ctx.close();
  }
}
