import { connection } from 'next/server';
import { metadataOf } from '../../lib/docs';

export async function generateMetadata({ params }) { await connection(); return metadataOf((await params).doc); }
export default async function Page({ params }) { await connection(); return <h1>dynamic {(await params).doc}</h1>; }
