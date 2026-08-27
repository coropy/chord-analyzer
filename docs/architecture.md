# MIDI Code Analyzer — Architecture Specification

> Phase 0 調査結果（環境・MIDI・WAV）と、承認済み Phase 1 architecture、およびその後の追加修正を統合した、実装の仕様書。
>
> ステータス: **承認済み / 実装開始前**。Phase 2（Renderer benchmark）から着手する。

---

## 1. プロジェクトの目的（修正版）

このアプリの**最初の目的は「MIDIから自動的にコードを検出すること」ではない**。

ユーザーが MIDI/WAV を再生しながら、**コードが鳴り始めた瞬間を Enter（またはクリック）で手動記録**し、記録点から **隣接する2点間を Chord Region** として定義する。

```
Enter → Marker A
Enter → Marker B
Enter → Marker C

A-B = Chord Region 1
B-C = Chord Region 2
```

後の **Chord Analyzer** は、ユーザーが指定した Chord Region 内の MIDI notes **だけ**を入力として解析する。
これにより曲全体からコード境界の自動推定をせずに、Chord Recognition の精度を高められる。

**重要**:
- Chord Recognition engine 自体は初期フェーズでは実装しない。
- まず Timeline / MIDI visualization / WAV playback / synchronization / grid / marker / quantization / region editing を完成させる。
- Chord Analyzer は後の Phase で追加する。現段階では **interface / data model（型）だけ定義**してよい。

---

## 2. プロジェクト構成（調査結果 Phase 0）

```
C:\Users\alpha\OneDrive\デスクトップ\mt3\chord-analyzer
├─ .git/                 (clean, 単一commit)
├─ data/
│  ├─ nakanori_instrumental.wav   66,326,488 B
│  └─ nakanori_mt3.mid            12,285 B
├─ docs/                 (本仕様)
├─ output/               (空)
├─ src/                  (空)
├─ tests/                (空)
└─ ...
```

### MIDI ファイル（`nakanori_mt3.mid`）
| 項目 | 値 |
|---|---|
| SMF format | 1（マルチトラック） |
| PPQ | **220** ticks/beat |
| トラック数 | 11 |
| tempo | 500,000 µs = **120 BPM**（tick 0 固定） |
| time signature | **4/4**（tick 0） |
| note_on(vel>0) 総数 | 1909（perc含む全ch） |
| 非パーカ | 1904 |
| 音域 | pitch 4–103 |
| 最後のnote tick | 81915 |

### WAV ファイル（`nakanori_instrumental.wav`）
| 項目 | 値 |
|---|---|
| 形式 | RIFF/WAVE, fmt=3 (IEEE float 32-bit) |
| チャンネル | 2（stereo） |
| sample rate | 44.1 kHz |
| block align / byte rate | 8 / 352,800 |
| data長 | 66,326,400 B |
| **duration** | **188.000 s** |

---

## 3. 技術スタック

| 領域 | 選択 |
|---|---|
| 言語 | TypeScript |
| ビルド | Vite |
| 描画 | **素の WebGL2**（**PixiJS 不使用**） |
| MIDI Renderer | 素の WebGL2 |
| UI | HTML / CSS / TypeScript（**React 不使用**）|
| Audio | Web Audio API（`AudioContext.currentTime` を canonical位置）|
| テスト | Vitest |
| Worker | MIDI parse / 解析 / 重いデータ処理を Web Worker へ |

**方針**:
- React/Vue は使わない。UI は手書き DOM + 型安全な module。
- GPU は WebGL2 + instanced/arrayed vertex で一括描画。
- WebGPU は将来の拡張候補（Phase 1 では使わない）。

---

## 4. Renderer（素の WebGL2）

### データフロー
```
MIDI parse (Worker, 1回)
   → Immutable note arrays (TypedArray)
   → GPU vertex buffer (startTick, durationTick, pitch, velocity, track ...)
   → 一括描画 (instanced / drawArrays)
```

### 規約
- MIDI note は **TypedArray / GPU buffer** で保持。
- **毎フレーム全 note の screen 座標を CPU で再計算しない**。
- note の `startTick / durationTick / pitch` 等を **GPU buffer** へ保持。
- **playheadTick / zoom / viewport 等は uniform として GPU へ渡す**。
- **shader 側で note の画面位置を計算**できる設計にする。
- **CPU→GPU 転送量を最小化**（視野内 range だけ update、もしくは全量固定+uniform変換）。
- **render loop から object allocation / GC を排除**。

### metric
- フレーム中の CPU→GPU 転送は「必要に応じてのみ」。

---

## 5. Performance 方針

- **120 FPS そのものを標的としない**。**ディスプレイの refresh rate に対して安定した frame pacing**を目標とする。
- 120 Hz なら **8.33 ms/frame 以内を安定的に維持** する。
- 可能なら 144 Hz / 240 Hz でも動作できる設計。
- benchmark は **10k / 100k / 500k / 1M notes**。
- 再生中の playhead 更新、horizontal scroll、zoom、resize を含めて測定。
- FPS だけでなく以下を測定する:
  - frame time
  - **1% low**
  - **0.1% low**
  - CPU update time
  - GPU render time
  - visible notes
  - GC pause（可能なら）

---

## 6. Audio

- **`AudioContext.currentTime` を audio position の canonical source** とする。
- **wall-clock / `performance.now()` を playhead / marker の source にしない**。
- WAV playback と将来の MIDI synth playback を **`AudioSource` abstraction の下に**置く。

```ts
interface AudioTimelineSource {
  readonly durationSeconds: number;
  getPositionSeconds(): number;      // audio-engine position (canonical)
  playFromSeconds(offset: number): void;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  onPositionUpdate?: (sec: number) => void;
}
```

---

## 7. Timeline と時間座標系

- **tick を canonical timeline unit** とする。
- MIDI timeline / WAV timeline / marker / chord event / playhead が**共通の timeline coordinate system** を使用。
- MIDI tick → timeline position の変換を **一箇所に集約**。

| 時刻系 | 役割 |
|---|---|
| `tick` | canonical（整数、PPQ基準） |
| `seconds` | audio-engine / 再生位置 |
| `bar/beat/subdivision` | 表示・編集用 |
| `screenX` | 描画のみ（renderer が算出） |

> wall-clock timestamp は canonical に**一切使わない**。

---

## 8. Chord Region & Marker（主機能）

### Marker データ保持（最低限）
```
rawTick          // ユーザー入力位置（quantize前）
quantizedTick    // quantize後
quantizeEnabled  // boolean
quantizeDivision // 1/4 | 1/8 | 1/16 | 1/32 など
```
- **Raw position と Quantized position は別々に保持**。Quantization でユーザー入力を破壊しない。
- Marker の時間は **AudioContext の再生位置**から取得。

### Chord Region
- 隣接 marker(A,B) → Region 1、(B,C) → Region 2。

### 関連型（将来の Chord Analyzer へそのまま渡せる構造）

```ts
interface Marker {
  id: string;
  rawTick: number;
  quantizedTick: number;
  quantizeEnabled: boolean;
  quantizeDivision: Division;
  // 派生（キャッシュ）:
  absoluteTime?: number;
}

interface ChordRegion {
  id: string;
  start: Marker;
  end: Marker;
}

interface NoteOnset {
  tick: number;
  pitch: number;
  velocity: number;
  track: number;
}

interface SimultaneousNoteGroup {
  tick: number;
  notes: NoteOnset[];
}

interface ChordCandidate {
  ticks: number;
  notes: ChordNote[];
  root?: number;
  quality?: string;
}

interface ChordEvent {
  tick: number;          // region start（canonical）
  startTick: number;
  endTick: number;
  notes: ChordNote[];    // region内のnote
  root?: number;
  quality?: string;
  confidence?: number;
}
```

### 将来の Chord pipeline
```
MIDI note events
  → note onset detection
  → onset clustering        (許容tick設定可能)
  → simultaneous note group
  → chord candidate
  → chord recognition
  → ChordEvent
```
- onset clustering の **許容時間/許容tickを設定可能** にし、後から変更して再解析できるようにする。

---

## 10. Grid

- Grid は **4/4 などの time signature** から生成し、**bar / beat / subdivision / tick** を共通 timeline 上に表示。
- 主要用途では **1小節を 8 分割する Grid を第一級サポート**。
- ただし **8回/小節 をハードコードしない**。4 / 8 / 16 等の **division を変更可能**。

---

## 11. UI

- 確認・変更できる項目:
  - BPM
  - Time Signature
  - Grid Division
  - Quantize ON/OFF
  - Quantize Division
- 描画対象:
  - MIDI notes / track / pitch / velocity / note duration
  - timeline / bar lines / beat lines / subdivision lines
  - bar number / beat number
  - playhead
  - marker（縦線）
  - chord region（隣接 marker 間を視覚表示）

---

## 12. キーボード操作

| キー | 動作 |
|---|---|
| Space | Play / Pause |
| **Enter** | **Marker 追加**（位置は AudioContext から取得）|
| **Backspace / Delete** | **最後 or 選択 Marker を削除** |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z / Ctrl+Y | Redo |

- Enter の時刻を GUI event timestamp で保存しない。必ず audio engine の再生位置を使い、そこから tick → quantize。

---

## 13. Undo / Redo / 状態

- Marker 操作を command history で管理（add / delete / move / edit）。
- Undo / Redo は Ctrl+Z / Ctrl+Shift+Z（+ Ctrl+Y）。

---

## 14. データ設計（分離）

```
MIDI Model
Audio Model
Timeline Model
Marker/Region Model
Render State
UI State
Playback State
```
- **UI state と high-frequency render state を分離**。playhead 位置は React 等の state で毎フレーム更新しない。

---

## 15. Module 分離

Project architecture として、以下を**可能な限り独立 module** にする:

- MIDI parsing
- chord analysis（将来）
- timeline
- renderer
- audio
- UI

### Worker
- **MIDI parsing、解析、重いデータ処理は Web Worker に移す**。
- **render loop に MIDI parsing / sorting / JSON生成 / filesystem 操作を入れない**。

---

## 16. 実装フェーズ

### Phase 2 — Renderer benchmark（次アクション）
まず**最小 WebGL2 benchmark**を実装する。
- unified typed-array note → GPU buffer → shader で位置計算。
- 10k / 100k / 500k / 1M notes。
- **FPS だけでなく frame time / 1% low / 0.1% low / CPU / GPU / visible notes で報告**。
- zoom / scroll / playhead / resize を含め測定。
- **十分な frame pacing が確認できてから MIDI viewer 本体（Phase 3）**。

### 以降
- Phase 3 — MIDI viewer（zoom/scroll/track）
- Phase 4 — Audio（WAV playback、AudioSource）
- Phase 5 — Synchronization（playhead=audio位置）
- Phase 6 — Quantization
- Phase 7 — Marker / Chord Region、編集
- Phase 8 — Undo/Redo
- Phase 9 — Profiling / 最適化
- Phase 10 — UX polish

### テスト（`tests/`）
- time conversion / quantization / tick / marker / chord region / audio position / tempo / timeline
- 可能なら property-based。

---

## 17. 完了条件（Phase 1 相当）

1. WAV 読み込み可
2. MIDI 読み込み可
3. MIDI note を timeline/piano roll 表示
4. WAV 再生可
5. playhead が audio 位置と同期
6. zoom 可
7. scroll 可
8. track 表示/非表示可
9. Enter で用 mark 追加可
10. quant化の動作
11. marker 編集可
12. marker 削除可
13. Undo/Redo 可
14. Chord Region 表示
15. 保存可
16. 単体テスト存在
17. audio⇔music 変換テスト存在
18. performance overlay 存在
19. 実MIDIで滑らかに動作
20. 再生中にカクつかない