import type { TransportSnapshot } from '@/lib/audio/player';
import type { ProjectState } from '@/types/project';
import MixerChannelStrip from './mixer/MixerChannelStrip';
import MixerFxBusPanel from './mixer/MixerFxBusPanel';
import MixerMasterStrip from './mixer/MixerMasterStrip';

interface ConsoleMixerPanelProps {
  project: ProjectState;
  trackKeys: string[];
  instruments: Record<string, string[]>;
  transport: TransportSnapshot;
  fxBusUi: { reverbReturn: number; delayReturn: number; bypassed: boolean };
  autoMixBusy: boolean;
  onToggleTrackFlag: (trackId: string, field: 'mute' | 'solo') => void;
  onMutateWithUndo: (updater: (prev: ProjectState) => ProjectState) => void;
  onUpdateProject: (updater: (prev: ProjectState) => ProjectState) => void;
  onChannelEq: (
    trackId: string,
    eqPatch: { lowDb?: number; midDb?: number; highDb?: number },
    withUndo?: boolean
  ) => void;
  onChannelSend: (
    trackId: string,
    sendPatch: { reverbSend?: number; delaySend?: number },
    withUndo?: boolean
  ) => void;
  onTrackVolumePan: (trackId: string, field: 'volume' | 'pan', value: number) => void;
  onFxBusChange: (patch: Partial<{ reverbReturn: number; delayReturn: number; bypassed: boolean }>) => void;
  onAutoMix: () => void;
}

export default function ConsoleMixerPanel({
  project,
  trackKeys,
  instruments,
  transport,
  fxBusUi,
  autoMixBusy,
  onToggleTrackFlag,
  onMutateWithUndo,
  onUpdateProject,
  onChannelEq,
  onChannelSend,
  onTrackVolumePan,
  onFxBusChange,
  onAutoMix,
}: ConsoleMixerPanelProps) {
  const syncDelayMs = Math.round(
    Math.max(0.12, Math.min(0.75, 0.75 * (60 / Math.max(40, transport.bpm || 100)))) * 1000
  );
  const vocalRev = Math.round((project.tracks.vocal?.reverb_send ?? 0) * 100);
  const leadRev = Math.round((project.tracks.lead?.reverb_send ?? 0) * 100);
  const vocalDly = Math.round((project.tracks.vocal?.delay_send ?? 0) * 100);
  const leadDly = Math.round((project.tracks.lead?.delay_send ?? 0) * 100);

  return (
    <div className="flex gap-2.5 overflow-x-auto pb-1">
      {trackKeys.map((trackId) => {
        const track = project.tracks[trackId];
        if (!track) return null;
        const trackInstruments =
          instruments[trackId] || (track.type === 'midi' && track.instrument ? [track.instrument] : []);
        return (
          <MixerChannelStrip
            key={trackId}
            trackId={trackId}
            track={track}
            instruments={trackInstruments}
            channelPeakDb={transport.channelPeakDb?.[trackId] ?? -60}
            isPlaying={transport.isPlaying}
            onToggleTrackFlag={onToggleTrackFlag}
            onMutateWithUndo={onMutateWithUndo}
            onChannelEq={onChannelEq}
            onChannelSend={onChannelSend}
            onTrackVolumePan={onTrackVolumePan}
          />
        );
      })}

      <MixerFxBusPanel
        fxBusUi={fxBusUi}
        syncDelayMs={syncDelayMs}
        vocalRev={vocalRev}
        leadRev={leadRev}
        vocalDly={vocalDly}
        leadDly={leadDly}
        onFxBusChange={onFxBusChange}
      />

      <MixerMasterStrip
        project={project}
        masterPeakDb={transport.masterPeakDb}
        autoMixBusy={autoMixBusy}
        onMutateWithUndo={onMutateWithUndo}
        onUpdateProject={onUpdateProject}
        onAutoMix={onAutoMix}
      />
    </div>
  );
}
