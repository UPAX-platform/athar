import { connection } from 'next/server';

export const docOf = letter => `d_${letter.repeat(24)}`;
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** Metadata as a Next application declares it; `other` renders `<meta name="folio:doc">`. */
export const metadataOf = (letter, route) => ({
  title: `Document ${letter}`,
  other: { 'folio:doc': docOf(letter), 'folio:locale': 'en-US', 'folio:path': `/${route}/${letter}` },
});
/** Dynamic metadata resolved after a delay, which Next streams after the page shell. */
export async function slowMetadataOf(letter, route, ms) {
  await connection();
  await pause(ms);
  return metadataOf(letter, route);
}
