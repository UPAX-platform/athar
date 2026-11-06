import { metadataOf } from '../../lib/docs';

export const generateStaticParams = () => [{ doc: 'a' }, { doc: 'b' }];
export async function generateMetadata({ params }) { return metadataOf((await params).doc); }
export default async function Page({ params }) { return <h1>static {(await params).doc}</h1>; }
