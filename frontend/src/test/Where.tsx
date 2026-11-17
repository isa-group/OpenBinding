import { useLocation } from 'react-router-dom';

/** An empty element that carries the address of the router (`data-address`), for the tests that follow the address. */
export function Where() {
  const location = useLocation();
  return <i hidden data-testid="address" data-address={`${location.pathname}${location.search}`} />;
}
