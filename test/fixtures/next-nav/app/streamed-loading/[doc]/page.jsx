import { pause, slowMetadataOf } from '../../lib/docs';

export async function generateMetadata({ params }) { return slowMetadataOf((await params).doc, 'streamed-loading', 1000); }
export default async function Page({ params }) { await pause(1500); return <h1>streamed-loading {(await params).doc}</h1>; }
