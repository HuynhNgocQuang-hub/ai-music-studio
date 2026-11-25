import { useEffect, useState } from 'react';

export interface WebMidiStatus {
  supported: boolean;
  connected: boolean;
  deviceNames: string[];
  lastNote: { pitch: number; velocity: number } | null;
}

export function useWebMidi({
  enabled = true,
  onNoteOn,
}: {
  enabled?: boolean;
  onNoteOn?: (pitch: number, velocity: number) => void;
}): WebMidiStatus {
  const supported =
    typeof navigator !== 'undefined' &&
    typeof (navigator as unknown as { requestMIDIAccess?: unknown }).requestMIDIAccess === 'function';

  const [deviceNames, setDeviceNames] = useState<string[]>([]);
  const [lastNote, setLastNote] = useState<{ pitch: number; velocity: number } | null>(null);

  useEffect(() => {
    if (!enabled || !supported) return;
    let cancelled = false;
    let midiAccess: {
      inputs: { values: () => Iterable<{ id: string; name?: string | null; onmidimessage: ((ev: { data: Uint8Array }) => void) | null }> };
      onstatechange: (() => void) | null;
    } | null = null;

    const onNoteRef = onNoteOn;

    const bindInputs = () => {
      if (!midiAccess || cancelled) return;
      const names: string[] = [];
      for (const input of midiAccess.inputs.values()) {
        if (input.name) names.push(input.name);
        input.onmidimessage = (ev) => {
          const data = ev.data;
          if (!data || data.length < 3) return;
          const status = data[0] & 0xf0;
          const pitch = data[1];
          const velocity = data[2];
          if (status === 0x90 && velocity > 0) {
            setLastNote({ pitch, velocity });
            onNoteRef?.(pitch, velocity);
          }
        };
      }
      setDeviceNames(names);
    };

    const req = (
      navigator as unknown as {
        requestMIDIAccess: () => Promise<typeof midiAccess>;
      }
    ).requestMIDIAccess;

    req
      .call(navigator)
      .then((access) => {
        if (cancelled || !access) return;
        midiAccess = access;
        bindInputs();
        access.onstatechange = bindInputs;
      })
      .catch(() => {
        if (!cancelled) setDeviceNames([]);
      });

    return () => {
      cancelled = true;
      if (midiAccess) {
        midiAccess.onstatechange = null;
        for (const input of midiAccess.inputs.values()) {
          input.onmidimessage = null;
        }
      }
    };
  }, [enabled, supported, onNoteOn]);

  return {
    supported,
    connected: deviceNames.length > 0,
    deviceNames,
    lastNote,
  };
}
