"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

interface Crumb {
  href?: string;
  label: string;
}

function prettify(value: string): string {
  return decodeURIComponent(value).replace(/[-_]/g, " ");
}

function shortSha(value: string): string {
  return decodeURIComponent(value).slice(0, 8);
}

function shortSurfaceLabel(value: string): string {
  const normalized = prettify(value);
  return normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized;
}

function buildCrumbs(pathname: string, repoId: string | null): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: Crumb[] = [{ href: "/", label: "DriftCube" }];

  if (segments.length === 0) {
    crumbs.push({ label: "Command Center" });
    return crumbs;
  }

  if (segments[0] === "alerts") {
    crumbs.push({ label: "Alert Stream" });
    return crumbs;
  }

  if (segments[0] === "fleet") {
    crumbs.push({ label: "Fleet Intelligence" });
    return crumbs;
  }

  if (segments[0] === "repos" && !segments[1]) {
    crumbs.push({ label: "Surface Manager" });
    return crumbs;
  }

  if (segments[0] === "repos" && segments[1]) {
    crumbs.push({ href: `/repos/${encodeURIComponent(segments[1])}`, label: prettify(segments[1]) });
    if (segments[2] === "refactors") {
      crumbs.push({ label: "Refactors" });
    } else if (!segments[2]) {
      crumbs[crumbs.length - 1] = { label: prettify(segments[1]) };
    }
    return crumbs;
  }

  if (segments[0] === "components" && segments[1]) {
    if (repoId) {
      crumbs.push({ href: `/repos/${encodeURIComponent(repoId)}`, label: prettify(repoId) });
    }
    crumbs.push({ label: "Component" });
    crumbs.push({ label: prettify(segments[1]) });
    return crumbs;
  }

  if (segments[0] === "commits" && segments[1]) {
    if (repoId) {
      crumbs.push({ href: `/repos/${encodeURIComponent(repoId)}`, label: prettify(repoId) });
    }
    crumbs.push({ label: "Commit" });
    crumbs.push({ label: shortSha(segments[1]) });
    return crumbs;
  }

  crumbs.push({ label: prettify(segments[segments.length - 1] ?? "surface") });
  return crumbs;
}

export function AppChrome() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const repoId = searchParams.get("repoId") ?? (pathname.startsWith("/repos/") ? pathname.split("/")[2] ?? null : null);
  const crumbs = buildCrumbs(pathname, repoId);

  return (
    <header className="app-chrome">
      <div className="app-chrome-inner">
        <Link href="/" className="chrome-brand">
          <span className="chrome-brand-mark" />
          <div className="chrome-brand-copy">
            <strong>DriftCube</strong>
            <span>AI Code Observability</span>
          </div>
        </Link>

        <div className="chrome-route">
          <nav className="crumb-trail" aria-label="Breadcrumb">
            {crumbs.map((crumb, index) => (
              <div key={`${crumb.label}-${index}`} className="crumb-node">
                {crumb.href && index < crumbs.length - 1 ? (
                  <Link href={crumb.href} className="crumb-link">{crumb.label}</Link>
                ) : (
                  <span className="crumb-current">{crumb.label}</span>
                )}
                {index < crumbs.length - 1 ? <span className="crumb-divider">/</span> : null}
              </div>
            ))}
          </nav>
        </div>

        <div className="chrome-actions">
          <Link href="/" className={`chrome-action ${pathname === "/" ? "chrome-action-active" : ""}`}>Home</Link>
          <Link href="/repos" className={`chrome-action ${pathname === "/repos" ? "chrome-action-active" : ""}`}>Surfaces</Link>
          <Link href="/alerts" className={`chrome-action ${pathname === "/alerts" ? "chrome-action-active" : ""}`}>Alerts</Link>
          <Link href="/fleet" className={`chrome-action ${pathname === "/fleet" ? "chrome-action-active" : ""}`}>Fleet</Link>
        </div>
      </div>
    </header>
  );
}
