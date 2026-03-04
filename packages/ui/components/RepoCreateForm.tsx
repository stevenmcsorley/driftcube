"use client";

import { useState, useTransition } from "react";
import { createRepo, type RepoSummary } from "../lib/api";

export function RepoCreateForm(props: {
  onCreated: (repo: RepoSummary) => void;
}) {
  const [kind, setKind] = useState<"local" | "remote">("local");
  const [name, setName] = useState("");
  const [hostPath, setHostPath] = useState(process.env.NEXT_PUBLIC_HOST_PATH_PREFIX ?? "/home/dev/");
  const [rootPath, setRootPath] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [watchEnabled, setWatchEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isPending, startTransition] = useTransition();
  const hostPrefix = process.env.NEXT_PUBLIC_HOST_PATH_PREFIX ?? "/home/dev";
  const containerPrefix = process.env.NEXT_PUBLIC_CONTAINER_PATH_PREFIX ?? "/host-repos";
  const normalizedHostPrefix = hostPrefix.replace(/\/+$/, "");
  const normalizedHostPath = hostPath.replace(/\/+$/, "");
  const mappedContainerPath = normalizedHostPath === normalizedHostPrefix || normalizedHostPath.startsWith(`${normalizedHostPrefix}/`)
    ? `${containerPrefix.replace(/\/+$/, "")}${normalizedHostPath.slice(normalizedHostPrefix.length)}`
    : null;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);

    try {
      const repo = await createRepo({
        name,
        kind,
        hostPath: kind === "local" ? hostPath : undefined,
        rootPath: kind === "local" && rootPath ? rootPath : undefined,
        remoteUrl: kind === "remote" ? remoteUrl : undefined,
        defaultBranch,
        watchEnabled,
      });

      startTransition(() => {
        props.onCreated(repo);
        setSuccess(`Registered ${repo.name}.`);
        setName("");
        if (kind === "remote") {
          setRemoteUrl("");
        } else {
          setRootPath("");
        }
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to register repository.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="intake-form" onSubmit={handleSubmit}>
      <div className="panel-heading">
        <div>
          <div className="eyebrow">Repo Intake</div>
          <h2 className="panel-title">Add Another Surface</h2>
        </div>
        <div className="pill-row">
          <button
            className={`switch-pill${kind === "local" ? " switch-pill-active" : ""}`}
            onClick={() => setKind("local")}
            type="button"
          >
            Local
          </button>
          <button
            className={`switch-pill${kind === "remote" ? " switch-pill-active" : ""}`}
            onClick={() => setKind("remote")}
            type="button"
          >
            Remote
          </button>
        </div>
      </div>

      <label className="field">
        <span>Name</span>
        <input
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="payments-core"
        />
      </label>

      {kind === "local" ? (
        <>
          <label className="field">
            <span>Host Path</span>
            <input
              required
              value={hostPath}
              onChange={(event) => setHostPath(event.target.value)}
              placeholder="/home/dev/code/payments-core"
            />
          </label>

          <label className="field">
            <span>Container Path Override</span>
            <input
              value={rootPath}
              onChange={(event) => setRootPath(event.target.value)}
              placeholder={mappedContainerPath ?? "/host-repos/code/payments-core"}
            />
          </label>
        </>
      ) : (
        <label className="field">
          <span>Remote URL</span>
          <input
            required
            value={remoteUrl}
            onChange={(event) => setRemoteUrl(event.target.value)}
            placeholder="https://github.com/acme/payments-core"
          />
        </label>
      )}

      <label className="field">
        <span>Default Branch</span>
        <input
          required
          value={defaultBranch}
          onChange={(event) => setDefaultBranch(event.target.value)}
          placeholder="main"
        />
      </label>

      <div className="intake-note">
        Local repositories are watched from inside Docker. Host paths under <code>{hostPrefix}</code> are mapped to <code>{containerPrefix}</code>.
        Current watch path: <code>{rootPath || mappedContainerPath || "unmapped"}</code>
      </div>

      <label className="check-row">
        <input
          checked={watchEnabled}
          onChange={(event) => setWatchEnabled(event.target.checked)}
          type="checkbox"
        />
        <span>Activate this surface immediately</span>
      </label>

      {error ? <div className="form-state form-error">{error}</div> : null}
      {success ? <div className="form-state form-success">{success}</div> : null}

      <button className="intake-submit" disabled={submitting || isPending} type="submit">
        {submitting || isPending ? "Registering..." : "Register Repo"}
      </button>
    </form>
  );
}
