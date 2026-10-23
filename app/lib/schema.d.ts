import type { Show } from '../data';
import type { SiteSettings, SavedTemplate } from './branding';

export type StatePayload = {
  revision: number;
  shows: Show[];
  settings: SiteSettings;
  templates?: SavedTemplate[];
};

export function isShow(value: unknown): value is Show;
export function isStatePayload(value: unknown): value is StatePayload;
