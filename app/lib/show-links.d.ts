export function showLink(href: string, view: 'control' | 'display' | 'dsm' | 'dsm-preview' | 'chroma', id: string): string;
export function readShowLink(hash: string): { view: 'control' | 'display' | 'dsm' | 'dsm-preview' | 'chroma'; id: string } | null;
