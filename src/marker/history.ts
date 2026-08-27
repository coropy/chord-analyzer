/**
 * Undo/Redo command engine for the marker store.
 *
 * All mutations go through this Engine, which mutates a StoreState and records
 * a command on the undo stack. `undo()`/`redo()` invert/redo using the stored
 * snapshots. Commands are plain data and cheap; the engine holds no DOM/WebGL
 * references, so it is trivially testable.
 */
import type { Marker, QuantizeLayout } from './marker';
import { makeMarker, requantize, ctx480 } from './marker';

export type MarkerCommand =
  | { kind: 'add'; marker: Marker }
  | { kind: 'delete'; marker: Marker; at: number }
  | { kind: 'move'; id: number; fromRaw: number; toRaw: number }
  | { kind: 'changeQuantize'; previous: QuantizeLayout; next: QuantizeLayout };

export class CommandEngine {
  layout: QuantizeLayout = { enabled: true, division: { barDivisions: 8 } };
  markers: Marker[] = [];
  selectedId: number | null = null;
  private nextId = 1;

  private undoStack: MarkerCommand[] = [];
  private redoStack: MarkerCommand[] = [];

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoDepth(): number { return this.undoStack.length; }

  addMarker(rawTick: number): Marker {
    const id = this.nextId++;
    const m = makeMarker(id, rawTick, this.layout, ctx480);
    this.markers.push(m);
    this.selectedId = id;
    this.undoStack.push({ kind: 'add', marker: m });
    this.redoStack = [];
    return m;
  }

  deleteMarker(id: number): boolean {
    const i = this.markers.findIndex((m) => m.id === id);
    if (i < 0) return false;
    const removed = this.markers[i];
    this.markers.splice(i, 1);
    if (this.selectedId === id) this.selectedId = null;
    this.undoStack.push({ kind: 'delete', marker: removed, at: i });
    this.redoStack = [];
    return true;
  }

  /** Select a marker by id (does not create a history command). */
  select(id: number | null): void { this.selectedId = id; }

  /** Move `id` to a new raw tick; quantizedTick is recomputed from rawTick. */
  moveMarker(id: number, newRaw: number): void {
    const i = this.markers.findIndex((m) => m.id === id);
    if (i < 0) return;
    const prev = this.markers[i];
    this.markers[i] = requantize({ ...prev, rawTick: newRaw }, this.layout, ctx480);
    this.undoStack.push({ kind: 'move', id, fromRaw: prev.rawTick, toRaw: newRaw });
    this.redoStack = [];
  }

  /** Toggle/enable the global quantize layout; re-quantizes all markers. */
  setLayout(layout: QuantizeLayout): void {
    const prev = this.layout;
    if (sameLayout(prev, layout)) return;
    this.layout = { ...layout };
    this.markers = this.markers.map((m) => (layout.enabled ? requantize(m, layout, ctx480) : { ...m, quantizeEnabled: false, quantizedTick: m.rawTick }));
    this.undoStack.push({ kind: 'changeQuantize', previous: prev, next: { ...layout } });
    this.redoStack = [];
  }

  undo(): boolean {
    const c = this.undoStack.pop();
    if (!c) return false;
    switch (c.kind) {
      case 'add': {
        const i = this.markers.findIndex((m) => m.id === c.marker.id);
        if (i >= 0) this.markers.splice(i, 1);
        if (this.selectedId === c.marker.id) this.selectedId = null;
        break;
      }
      case 'delete': {
        this.markers.splice(c.at, 0, c.marker);
        this.selectedId = c.marker.id;
        break;
      }
      case 'move': {
        this.markers = this.markers.map((m) => m.id !== c.id ? m : requantize({ ...m, rawTick: c.fromRaw }, this.layout, ctx480));
        break;
      }
      case 'changeQuantize': {
        this.layout = { ...c.previous };
        this.markers = this.markers.map((m) => (c.previous.enabled ? requantize(m, this.layout, ctx480) : { ...m, quantizeEnabled: false, quantizedTick: m.rawTick }));
        break;
      }
    }
    this.redoStack.push(c);
    return true;
  }

  redo(): boolean {
    const c = this.redoStack.pop();
    if (!c) return false;
    switch (c.kind) {
      case 'add': this.markers.push(c.marker); this.selectedId = c.marker.id; break;
      case 'delete': {
        const i = this.markers.findIndex((m) => m.id === c.marker.id);
        if (i >= 0) this.markers.splice(i, 1);
        break;
      }
      case 'move': {
        this.markers = this.markers.map((m) => (m.id !== c.id ? m : requantize({ ...m, rawTick: c.toRaw }, this.layout, ctx480)));
        break;
      }
      case 'changeQuantize': {
        this.layout = { ...c.next };
        this.markers = this.markers.map((m) => (c.next.enabled ? requantize(m, this.layout, ctx480) : { ...m, quantizeEnabled: false, quantizedTick: m.rawTick }));
        break;
      }
    }
    this.undoStack.push(c);
    return true;
  }

  clear(): void {
    this.markers = [];
    this.selectedId = null;
    this.nextId = 1;
    this.undoStack = [];
    this.redoStack = [];
  }
}

function sameLayout(a: QuantizeLayout, b: QuantizeLayout): boolean {
  if (a.enabled !== b.enabled) return false;
  if (a.division === b.division) return true;
  if (typeof a.division === 'string' || typeof b.division === 'string') return a.division === b.division;
  return a.division.barDivisions === b.division.barDivisions;
}