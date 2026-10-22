'use client';

/**
 * Settings were at /defaults until 2026-10-22 (operator: "rename the route defaults to settings"). A link or a bookmark
 * to the old address goes on to /settings, with the part after # it named (#skills, #execution).
 */
import { useEffect } from 'react';

export default function OldSettingsAddress() {
  useEffect(() => {
    window.location.replace(`/settings${window.location.hash}`);
  }, []);
  return null;
}
