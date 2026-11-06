import Link from 'next/link';
import { Analytics } from './analytics';

const routes = ['constant', 'static', 'dynamic', 'streamed', 'streamed-loading', 'streamed-prefetch', 'body', 'layout-title'];

export default function Layout({ children }) {
  return <html lang="en"><body>
    <Analytics>
      <nav>{routes.flatMap(route => ['a', 'b'].map(doc => (
        <Link key={route + doc} id={`${route}-${doc}`} href={`/${route}/${doc}`} prefetch={route === 'streamed-prefetch' ? true : false}>{route} {doc}</Link>
      )))}</nav>
      {children}
    </Analytics>
  </body></html>;
}
