/**
 * Hash-based router.
 *
 * Hash routing rather than the History API because GitHub Pages serves this
 * from a subpath with no server-side rewrite; a deep link like /release/x
 * would 404 on refresh. Hash routes survive both refresh and offline launch
 * from the home screen.
 */

export interface Route {
  name: string;
  params: Record<string, string>;
}

export type RouteHandler = (route: Route) => void;

interface Pattern {
  name: string;
  segments: string[];
}

export class Router {
  private patterns: Pattern[] = [];
  private handler: RouteHandler = () => undefined;
  private current: Route = { name: 'library', params: {} };

  /** Register a route, e.g. 'release/:id'. */
  register(pattern: string): this {
    const [name, ...rest] = pattern.split('/');
    this.patterns.push({ name: name!, segments: rest });
    return this;
  }

  start(handler: RouteHandler): void {
    this.handler = handler;
    window.addEventListener('hashchange', () => this.resolve());
    this.resolve();
  }

  get route(): Route {
    return this.current;
  }

  navigate(path: string, options: { replace?: boolean } = {}): void {
    const hash = `#/${path.replace(/^\/+/, '')}`;
    if (options.replace) {
      history.replaceState(null, '', hash);
      this.resolve();
    } else if (window.location.hash === hash) {
      this.resolve();
    } else {
      window.location.hash = hash;
    }
  }

  back(fallback = 'library'): void {
    if (history.length > 1) history.back();
    else this.navigate(fallback, { replace: true });
  }

  private resolve(): void {
    const raw = window.location.hash.replace(/^#\/?/, '');
    const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
    const name = parts[0] ?? 'library';

    const pattern =
      this.patterns.find((p) => p.name === name && p.segments.length === parts.length - 1) ??
      this.patterns.find((p) => p.name === name);

    if (!pattern) {
      this.current = { name: 'library', params: {} };
      this.handler(this.current);
      return;
    }

    const params: Record<string, string> = {};
    pattern.segments.forEach((segment, index) => {
      if (segment.startsWith(':')) {
        const value = parts[index + 1];
        if (value !== undefined) params[segment.slice(1)] = value;
      }
    });

    this.current = { name: pattern.name, params };
    this.handler(this.current);
  }
}
