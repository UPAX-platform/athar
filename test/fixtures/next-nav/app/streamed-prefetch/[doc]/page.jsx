import { slowMetadataOf } from '../../lib/docs';

export async function generateMetadata({ params }) { return slowMetadataOf((await params).doc, 1000); }
export default async function Page({ params }) { return <h1>streamed-prefetch {(await params).doc}</h1>; }
