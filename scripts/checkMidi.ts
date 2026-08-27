import { readFile } from 'node:fs/promises';
import { parseMidi } from '../src/midi/MidiParser';

const path = 'data/nakanori_mt3.mid';
const bytes = new Uint8Array(await readFile(path));
const m = parseMidi(bytes);
console.log('format:', m.format);
console.log('ppq:', m.ppq);
console.log('tracks:', m.tracks.length);
console.log('notes:', m.notes.length);
console.log('durationTicks:', m.durationTicks);
console.log('tempos:', m.tempos.map((t) => `@${t.tick}:${t.tempo}`).join(', '));
console.log('timeSigs:', m.timeSignatures.map((t) => `@${t.tick}:${t.numerator}/${2 ** t.denominatorPower}`).join(', '));
m.tracks.forEach((t) => {
  console.log(`  track ${t.index}: name=${JSON.stringify(t.name)} notes=${t.noteCount} progs=${[...t.programsByChannel.entries()].map(([c, p]) => `${c}=${p}`).join(',')} ch=[${[...t.channels].join(',')}] perc=${t.isPercussion}`);
});
// verify vs mido baseline: 1909 note_on; expect ~1909 paired notes
console.log('expected notes≈1909');