import type { Show } from '../data';
import type { SiteSettings, SavedTemplate } from './branding';
type Data = { shows: Show[]; settings: SiteSettings; templates?: SavedTemplate[] };
export function serialize(value: unknown): string;
export function timerCommands(base: Data, next: Data, explicit?: string[]): string[];
export function mergeState(base: Data, local: Data, remote: Data,
  baseVersions?: Record<string, unknown>, remoteVersions?: Record<string, unknown>, explicit?: string[]): Data;
