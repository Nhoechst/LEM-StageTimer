export type UploadedFont = { name: string; data: string };
export const FONT_FIELDS: ('timerFont' | 'textFont')[];
export const MAX_FONT_BYTES: number;
export function fontBytes(data: unknown): Uint8Array | null;
export function isFont(value: unknown): value is UploadedFont | null;
export function readFont(file: File): Promise<UploadedFont>;
