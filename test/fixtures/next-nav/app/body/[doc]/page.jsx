import { docOf } from '../../lib/docs';

export const generateStaticParams = () => [{ doc: 'a' }, { doc: 'b' }];
/** React hoists these into the head when the page commits. */
export default async function Page({ params }) {
  const { doc } = await params;
  return <>
    <title>{`Document ${doc}`}</title>
    <meta name="folio:doc" content={docOf(doc)} />
    <meta name="folio:locale" content="en-US" />
    <h1>body {doc}</h1>
  </>;
}
