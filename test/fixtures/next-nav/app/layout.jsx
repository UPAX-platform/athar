import Link from 'next/link';
import { Analytics } from './analytics';

const routes = ['constant', 'static', 'dynamic', 'streamed', 'streamed-loading', 'streamed-prefetch', 'auto-loading', 'body', 'layout-title'];

/** A full prefetch, Next's default (the loading shell only), or none. */
const prefetchOf = route => route === 'streamed-prefetch' ? true : route === 'auto-loading' ? undefined : false;

export default function Layout({ children }) {
  return <html lang="en"><body>
    <Analytics>
      <nav>{routes.flatMap(route => ['a', 'b'].map(doc => (
        <Link key={route + doc} id={`${route}-${doc}`} href={`/${route}/${doc}`} prefetch={prefetchOf(route)}>{route} {doc}</Link>
      )))}</nav>
      {children}
    </Analytics>
  </body></html>;
}
