import type { Text } from '@codemirror/state';
import type { Diagnostic } from '@codemirror/lint';
import type { Completion } from '@codemirror/autocomplete';
type Position = { line: number; character: number };
type Identity = { path: string; editorId: string; version: number };
export function eligiblePath(path: string): boolean;
export function offsetAt(doc: Text, position: Position): number | null;
export function diagnosticsFor(doc: Text, items: unknown[]): Diagnostic[];
export function completionsFor(doc: Text, items: unknown[], from: number, cursor: number): Completion[];
export class DraftSession {
  constructor(path: string, editorId: string);
  version: number;
  closed: boolean;
  cancel(kind: string): void;
  changed(): void;
  destroy(): void;
  begin(kind: string, text: string, position?: Position): {
    body: Identity & { text: string; position?: Position };
    signal: AbortSignal;
    abort: () => void;
    current: (reply: Identity) => boolean;
  };
}
