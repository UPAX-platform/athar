export async function load({ params }: { params: { doc: string } }) {
  // A slow load, so the router has to wait for data before it renders the new page.
  await new Promise(resolve => setTimeout(resolve, 300));
  return { letter: params.doc };
}
