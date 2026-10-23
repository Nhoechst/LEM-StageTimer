import type { Show, CueType } from '../data';
export function cueType(show: Show): CueType;
export function modeLabel(type: CueType): string;
export function clockAnchor(show: Show, now?: number): number;
export function projectTimer(show: Show, anchor: number, now?: number): void;
export function formatTimer(show: Show, now?: Date): string;
