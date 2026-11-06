import { slowMetadataOf } from '../../lib/docs';

export async function generateMetadata({ params }) {
  const { title: _title, ...metadata } = await slowMetadataOf((await params).doc, 1000);
  return metadata;
}
export default async function Page({ params }) { return <h1>layout-title {(await params).doc}</h1>; }
