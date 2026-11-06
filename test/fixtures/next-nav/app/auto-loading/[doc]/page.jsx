import { pause, slowMetadataOf } from '../../lib/docs';

export async function generateMetadata({ params }) { return slowMetadataOf((await params).doc, 'auto-loading', 1000); }
export default async function Page({ params }) { await pause(1500); return <h1>auto-loading {(await params).doc}</h1>; }
