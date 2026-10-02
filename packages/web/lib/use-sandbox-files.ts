"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { resolveAgentUrl } from "@/lib/agent";

/**
 * The coder subagent's filesystem, read over HTTP.
 *
 * WHY THIS EXISTS AT ALL. Every other filesystem in this app is graph state: the
 * supervisor uses a StateBackend, so `stream.values.files` is already reactive and
 * `FilePanel` is a plain read. The coder is different — its files live on a real machine
 * that only the agent server holds a credential for. So they arrive through two routes on
 * that server (see packages/agent/http_app.py), proxied same-origin like everything else.
 *
 * WHAT CHANGED, AND WHY, is worth knowing before editing this.
 *
 * The reference implementation — and this hook's first version — worked out what the
 * agent had changed by keeping a copy of every file as it was, then comparing. That copy
 * lived in React state, which means it died on every reload, navigation and remount. And
 * the failure was silent in the worst way: after a reload the page re-read the files,
 * had nothing to compare against, adopted the ALREADY EDITED versions as the "before",
 * and showed no changes at all. Watched happen, repeatedly.
 *
 * So the "before" is not remembered here any more. The sandbox commits the workspace to
 * a local git repository, and the page asks it what differs. A commit on the machine
 * cannot be lost by a browser. It also handles created and deleted files, which
 * comparing two maps of contents does clumsily.
 *
 * The remaining defects of the reference are still fixed here, marked FIX.
 */

/** One entry as `GET /sandbox/{id}/tree` returns it. */
export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
}

export interface FileTreeNode extends FileEntry {
  children?: FileTreeNode[];
}

/** Absolute path -> contents. */
export type FileSnapshot = Record<string, string>;

/** One entry from `GET /sandbox/{id}/changes`, counted by git on the machine. */
export interface FileChange {
  path: string;
  status: "modified" | "added" | "deleted";
  additions: number;
  deletions: number;
}

/** Matches WORKDIR in packages/agent/agents/sandbox.py. */
export const WORKDIR = "/workspace";

/** Tools whose RESULT means the filesystem may have moved. */
export const FILE_MUTATING_TOOLS = new Set([
  "write_file",
  "edit_file",
  // FIX 6: the reference's set omits `delete`, though the guide's own best-practice list
  // includes it and our supervisor gates it.
  "delete",
  "execute",
]);

/*
 * These are reads of live state, and the URL for a given file never changes — so the
 * browser will happily serve the version it fetched before the agent edited it, and the
 * panel shows stale contents with a successful 200 and nothing to indicate why.
 */
const NO_STORE: RequestInit = { cache: "no-store" };

export interface SandboxFiles {
  tree: FileTreeNode[];
  /** `null` until a sandbox exists for this thread. The page uses it to pick a layout. */
  sandboxId: string | null;
  files: FileSnapshot;
  /** Contents at the baseline commit, fetched on demand for changed files only. */
  originalFiles: FileSnapshot;
  /** What git reports as different from the baseline, with its own line counts. */
  changes: FileChange[];
  changedFiles: Set<string>;
  selectedFile: string | null;
  selectFile: (path: string) => void;
  closeFile: () => void;
  expandedDirs: Set<string>;
  toggleDir: (path: string) => void;
  isLoading: boolean;
  /** Call on submit: commits the workspace, so this run's diff starts from here. */
  takeSnapshot: () => void;
  refreshPath: (path: string) => void;
  refreshAll: () => void;
}

/**
 * Nest a flat entry list.
 *
 * FIX 1: sort by DEPTH first. The reference sorts by type then name globally, so
 * `/workspace/a/b` can be visited before `/workspace/z` — and when the parent is not in
 * the map yet the reference quietly pushes the node onto the root instead of erroring.
 * The tree silently flattens, and only for some inputs. Depth-first ordering means a
 * parent is always registered before its children.
 */
function buildTree(entries: FileEntry[], root: string): FileTreeNode[] {
  const depth = (p: string) => p.split("/").length;
  const sorted = [...entries].sort(
    (a, b) =>
      depth(a.path) - depth(b.path) ||
      (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1),
  );

  const nodes: FileTreeNode[] = [];
  const dirs = new Map<string, FileTreeNode>();

  for (const entry of sorted) {
    const node: FileTreeNode = {
      ...entry,
      children: entry.type === "directory" ? [] : undefined,
    };
    if (entry.type === "directory") dirs.set(entry.path, node);

    const parentPath = entry.path.slice(0, entry.path.lastIndexOf("/"));
    const parent = parentPath === root ? undefined : dirs.get(parentPath);
    if (parent?.children) parent.children.push(node);
    else nodes.push(node);
  }
  return nodes;
}

/** Every directory on the way to `path`, so a selected file can be revealed. */
function ancestorsOf(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push("/" + parts.slice(0, i).join("/"));
  return out;
}

export function useSandboxFiles(threadId: string | null): SandboxFiles {
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [sandboxId, setSandboxId] = useState<string | null>(null);
  const [files, setFiles] = useState<FileSnapshot>({});
  const [originalFiles, setOriginalFiles] = useState<FileSnapshot>({});
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set());
  const [isLoading, setIsLoading] = useState(false);

  const [base] = useState(resolveAgentUrl);

  /* Reading state inside callbacks without making them change identity every render.
     `originalFiles` in particular is read by every refresh. */
  const filesRef = useRef(files);
  filesRef.current = files;
  const originalsRef = useRef(originalFiles);
  originalsRef.current = originalFiles;



  /*
   * FIX 8: refreshes must not clobber each other.
   *
   * A full refresh replaces the whole map; a single-file refresh patches one key. Run
   * them concurrently and the newer result can be overwritten by the older one. "Edit a
   * file, then run the tests" produces exactly that pair, so it is the common case.
   *
   * They are SERIALISED rather than cancelled. Cancelling by generation counter was the
   * first attempt and it was worse: a full refresh and a single-file refresh would
   * cancel each other, so an edit could land with nothing marked as changed at all.
   * Running them one at a time means the last to finish is also the last to start, and
   * every result is kept.
   */
  const queue = useRef<Promise<void>>(Promise.resolve());
  const enqueue = useCallback((work: () => Promise<void>) => {
    queue.current = queue.current.then(work).catch(() => {});
    return queue.current;
  }, []);

  const fetchTree = useCallback(async (): Promise<{
    entries: FileEntry[];
    sandboxId: string | null;
  }> => {
    if (!threadId) return { entries: [], sandboxId: null };
    try {
      const res = await fetch(
        `${base}/sandbox/${encodeURIComponent(threadId)}/tree?filePath=${encodeURIComponent(WORKDIR)}`,
        NO_STORE,
      );
      if (!res.ok) return { entries: [], sandboxId: null };
      const data = (await res.json()) as { entries?: FileEntry[]; sandboxId?: string | null };
      if (!Array.isArray(data.entries)) return { entries: [], sandboxId: null };
      return {
        // Nobody wants to browse a dependency tree, and fetching one would be thousands
        // of requests.
        entries: data.entries.filter((e) => e.path !== WORKDIR && !e.path.includes("node_modules")),
        sandboxId: typeof data.sandboxId === "string" ? data.sandboxId : null,
      };
    } catch {
      return { entries: [], sandboxId: null };
    }
  }, [base, threadId]);

  const fetchFile = useCallback(
    async (path: string): Promise<string | null> => {
      if (!threadId) return null;
      try {
        const res = await fetch(
          `${base}/sandbox/${encodeURIComponent(threadId)}/file?filePath=${encodeURIComponent(path)}`,
          NO_STORE,
        );
        // FIX 9: the reference skips this check, so a 500 yields `null`, the path drops
        // out of the snapshot, and a transient server error is indistinguishable from the
        // agent having deleted the file — which then shows up as a change it never made.
        if (!res.ok) return null;
        const data = (await res.json()) as { content?: string };
        return typeof data.content === "string" ? data.content : null;
      } catch {
        return null;
      }
    },
    [base, threadId],
  );

  /** What git on the machine says differs from the baseline commit. */
  const fetchChanges = useCallback(async (): Promise<FileChange[]> => {
    if (!threadId) return [];
    try {
      const res = await fetch(
        `${base}/sandbox/${encodeURIComponent(threadId)}/changes`,
        NO_STORE,
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { files?: FileChange[] };
      return Array.isArray(data.files) ? data.files : [];
    } catch {
      return [];
    }
  }, [base, threadId]);

  /** A file as it was at the baseline commit — the left-hand side of the diff. */
  const fetchBaseline = useCallback(
    async (path: string): Promise<string> => {
      if (!threadId) return "";
      try {
        const res = await fetch(
          `${base}/sandbox/${encodeURIComponent(threadId)}/file?rev=baseline&filePath=${encodeURIComponent(path)}`,
          NO_STORE,
        );
        if (!res.ok) return "";
        const data = (await res.json()) as { content?: string };
        // A file the agent created has no baseline content, and "" is the correct
        // left-hand side for it: the whole file reads as added.
        return typeof data.content === "string" ? data.content : "";
      } catch {
        return "";
      }
    },
    [base, threadId],
  );

  const refreshAll = useCallback(
    () =>
      enqueue(async () => {
        if (!threadId) return;
        setIsLoading(true);

        /*
         * Two requests, in parallel, and NOT the contents of every file.
         *
         * An earlier version downloaded the whole workspace on mount, because the
         * browser had to diff the files itself. Git does that on the machine now, so
         * the only things needed up front are the shape of the tree and the list of
         * changes — and they do not depend on each other. Fetching contents eagerly
         * made coming back to the page visibly slow: the changed-files panel was last
         * in a chain of about ten round trips, each one browser → proxy → sandbox.
         *
         * File contents are fetched when a file is opened. See `selectFile`.
         */
        const [{ entries, sandboxId: id }, changed] = await Promise.all([
          fetchTree(),
          fetchChanges(),
        ]);

        setTree(buildTree(entries, WORKDIR));
        setSandboxId(id);
        setChanges(changed);
        setIsLoading(false);

        // Open every directory the first time a tree arrives, so the workspace is not a
        // row of closed folders. Later refreshes leave the user's expansion alone.
        setExpandedDirs((prev) =>
          prev.size > 0
            ? prev
            : new Set(entries.filter((e) => e.type === "directory").map((e) => e.path)),
        );

        // Drop cached contents for paths that no longer exist, and FIX 12: if the open
        // file was deleted, close it rather than leaving the viewer on "Loading…".
        const live = new Set(entries.filter((e) => e.type === "file").map((e) => e.path));
        setFiles((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => live.has(k))));
        setSelectedFile((current) => (current && live.has(current) ? current : null));
      }),
    [threadId, fetchTree, fetchChanges, enqueue],
  );

  const refreshPath = useCallback(
    (path: string) =>
      enqueue(async () => {
        if (!threadId) return;

        // Always re-ask git: it knows about creations and deletions, and it is one
        // round trip whether or not this file happens to be open.
        setChanges(await fetchChanges());

        // Only re-read contents we are actually displaying. Nothing else needs them.
        if (!(path in filesRef.current)) return;
        const [content, before] = await Promise.all([fetchFile(path), fetchBaseline(path)]);
        if (content !== null) setFiles((prev) => ({ ...prev, [path]: content }));
        setOriginalFiles((prev) => ({ ...prev, [path]: before }));
      }),
    [threadId, fetchFile, fetchBaseline, fetchChanges, enqueue],
  );

  /**
   * Mark the workspace as it stands now, so this run's diff starts from here.
   *
   * A POST that commits on the machine, not a copy kept in this tab. That is the whole
   * point of the rewrite: a reload cannot lose a commit.
   */
  const takeSnapshot = useCallback(() => {
    if (!threadId) return;
    void fetch(`${base}/sandbox/${encodeURIComponent(threadId)}/baseline`, {
      method: "POST",
      ...NO_STORE,
    })
      .then(() => {
        setChanges([]);
        setOriginalFiles({});
      })
      .catch(() => {});
  }, [base, threadId]);

  const selectFile = useCallback(
    (path: string) => {
      setSelectedFile(path);

      // FIX 2 (half): reveal the file. With expansion held per-node, as the reference
      // does, selecting something two levels deep highlights a row inside a closed
      // folder and looks like the click did nothing.
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        for (const dir of ancestorsOf(path)) next.add(dir);
        return next;
      });

      // Contents are fetched here rather than up front, which is what keeps coming back
      // to the page fast. Both sides at once: the file now, and the file as it was, so
      // the diff can render without a second wait.
      void enqueue(async () => {
        const [content, before] = await Promise.all([fetchFile(path), fetchBaseline(path)]);
        if (content !== null) setFiles((prev) => ({ ...prev, [path]: content }));
        setOriginalFiles((prev) => ({ ...prev, [path]: before }));
      });
    },
    [fetchFile, fetchBaseline, enqueue],
  );

  const closeFile = useCallback(() => setSelectedFile(null), []);

  /** Just the paths, for the tree's modified markers. */
  const changedFiles = useMemo(() => new Set(changes.map((c) => c.path)), [changes]);

  const toggleDir = useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  /*
   * First load for a thread, and the probe that decides whether this page is an IDE: a
   * thread with no sandbox answers `sandboxId: null` and creates nothing.
   *
   * This is `refreshAll` rather than its own fetch. An earlier version duplicated the
   * logic here, and the two raced to establish the diff baseline — the standalone copy
   * was not on the queue, so whichever finished last won. When that was the copy running
   * after the agent had already edited a file, the baseline contained the fix and the
   * change was invisible. One code path cannot race itself.
   */
  useEffect(() => {
    if (!threadId) {
      setTree([]);
      setSandboxId(null);
      setFiles({});
      setOriginalFiles({});
      setChanges([]);
      setSelectedFile(null);
      setExpandedDirs(new Set());
      return;
    }
    void refreshAll();
  }, [threadId, refreshAll]);

  return useMemo(
    () => ({
      tree,
      sandboxId,
      files,
      originalFiles,
      changes,
      changedFiles,
      selectedFile,
      selectFile,
      closeFile,
      expandedDirs,
      toggleDir,
      isLoading,
      takeSnapshot,
      /* Returned as-is rather than wrapped in an arrow, so their identity is stable and
         the page's refresh effect does not re-run on every file update. A function
         returning Promise<void> is assignable to one returning void. */
      refreshPath,
      refreshAll,
    }),
    [
      tree,
      sandboxId,
      files,
      originalFiles,
      changes,
      changedFiles,
      selectedFile,
      selectFile,
      closeFile,
      expandedDirs,
      toggleDir,
      isLoading,
      takeSnapshot,
      refreshPath,
      refreshAll,
    ],
  );
}
