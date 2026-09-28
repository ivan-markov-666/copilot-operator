'use client';

import { useEffect, useState } from 'react';

import { api } from './api';

/**
 * Whether the operator chose, in Settings → Execution, to start unattended runs without the
 * "are you sure" question (`execution.mode: unattended` in `data/settings.json`).
 *
 * Read from `raw`, the settings file itself, for the reason the Settings page gives: `resolved`
 * carries only paths. Read once when the page opens, and false until it arrives or when it cannot
 * be read — the question is the safe side to be wrong on, and a failed read is no reason to skip it.
 *
 * It only ever removes the question. The run still starts in the mode the button names, and the
 * API still refuses an unattended run this machine does not allow (isolation, allowlist, a policy
 * lock), whatever this says.
 */
export function useUnattendedWithoutAsking(): boolean {
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .settings()
      .then((s) => {
        const exec = (s.raw.execution as { mode?: string } | undefined) ?? {};
        if (alive) setQuiet(exec.mode === 'unattended');
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return quiet;
}
