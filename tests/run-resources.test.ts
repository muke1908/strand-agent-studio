import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createCatalog } from "../server/catalog.ts";
import { createRunHost } from "../server/run-host.ts";
import { createRunStore } from "../server/run-store.ts";
import { cleanupRunWorktrees } from "../server/run-resources.ts";
import { fixtureBackend } from "../server/fixture-backend.ts";
import type { AgentBackend } from "../server/agent-backend.ts";
import { writeJson } from "../server/files.ts";
import { processIdentity } from "../server/process-owner.ts";
import { temporaryRoot, workflow, waitForRun } from "./helpers.ts";

function setup() {
  const root = fs.realpathSync(temporaryRoot());
  const repository = path.join(root, "owner checkout");
  const data = path.join(root, "workflow data");
  fs.mkdirSync(repository);
  fs.mkdirSync(data);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "-b", "main");
  fs.writeFileSync(path.join(repository, "source.txt"), "original\n");
  git("add", "source.txt");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Initial",
  );
  const commit = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repository, "source.txt"), "owner changes\n");
  const ownerStatus = git("status", "--porcelain");
  const config = { paths: { WORKFLOW_DATA: data, CHECKOUT: repository } };
  const catalog = createCatalog(path.join(root, "studio"), config);
  const definition = workflow();
  catalog.saveWorkflow(definition);
  const store = createRunStore(path.join(root, "studio"));
  function register(directory: string, runId: string) {
    const workspace = path.join(data, definition.id, "workspaces", runId);
    const branch = `refs/heads/strand/${definition.id}/${runId}`;
    fs.mkdirSync(path.dirname(workspace), { recursive: true });
    writeJson(path.join(directory, "worktree.json"), {
      kind: "git-worktree",
      runId,
      repository,
      workspace,
      branch,
      commit,
    });
    if (!fs.existsSync(workspace))
      git(
        "worktree",
        "add",
        "-b",
        branch.slice("refs/heads/".length),
        workspace,
        commit,
      );
    return workspace;
  }
  return {
    root,
    repository,
    data,
    git,
    commit,
    ownerStatus,
    catalog,
    store,
    definition,
    register,
  };
}

for (const outcome of ["completed", "blocked", "cancelled"] as const) {
  test(`owned worktrees and local branches are removed after ${outcome}, preserving owner changes`, async () => {
    const s = setup();
    const base = fixtureBackend();
    const started = Promise.withResolvers<string>();
    let workspace = "";
    const backend: AgentBackend = {
      ...base,
      async execute(request, signal) {
        if (request.purpose !== "stage") return base.execute(request, signal);
        const runId = path.basename(
          path.dirname(path.dirname(request.directory)),
        );
        workspace = s.register(request.directory, runId);
        started.resolve(runId);
        if (outcome === "blocked") throw new Error("Review failed");
        if (outcome === "cancelled")
          await new Promise<void>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason);
            else
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
          });
        return { summary: "Reviewed" };
      },
    };
    const host = createRunHost(path.join(s.root, "studio"), s.catalog, backend);
    try {
      const run = host.launch(
        s.definition.id,
        { context: "Review only" },
        `resource-${outcome}`,
      );
      await started.promise;
      if (outcome === "cancelled") host.stop(run.id);
      const final = await waitForRun(() => host.store.get(run.id));
      await host.close();
      assert.equal(final.status, outcome, final.error);
      assert(!fs.existsSync(workspace));
      assert.deepEqual(
        s
          .git("worktree", "list", "--porcelain", "-z")
          .split("\0")
          .filter((field) => field.startsWith("worktree "))
          .map((field) =>
            fs.realpathSync.native(field.slice("worktree ".length)),
          ),
        [fs.realpathSync.native(s.repository)],
      );
      assert.equal(
        s.git(
          "for-each-ref",
          "--format=%(refname)",
          `refs/heads/strand/${s.definition.id}/${run.id}`,
        ),
        "",
      );
      assert.equal(s.git("status", "--porcelain"), s.ownerStatus);
      assert.equal(
        fs.readFileSync(path.join(s.repository, "source.txt"), "utf8"),
        "owner changes\n",
      );
    } finally {
      await host.close();
      fs.rmSync(s.root, { recursive: true, force: true });
    }
  });
}

test("startup recovers an interrupted run's worktree, and rejects redirected ownership", async () => {
  const s = setup();
  let host: ReturnType<typeof createRunHost> | undefined;
  try {
    const run = s.store.create(
      s.definition,
      [],
      { context: "Review" },
      "crash",
      "test-fixture",
      undefined,
      false,
      {
        paths: { WORKFLOW_DATA: s.data },
        allowedFolders: [s.repository, s.data],
      },
    );
    run.status = "running";
    s.store.save(run);
    const attempt = path.join(s.store.directory(run.id), "attempts", "prepare");
    fs.mkdirSync(attempt, { recursive: true });
    const workspace = s.register(attempt, run.id);
    host = createRunHost(
      path.join(s.root, "studio"),
      s.catalog,
      fixtureBackend(),
    );
    assert.equal(host.store.get(run.id).status, "blocked");
    assert(!fs.existsSync(workspace));
    const descriptor = path.join(attempt, "worktree.json");
    const resource = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    writeJson(descriptor, { ...resource, workspace: s.repository });
    assert.throws(() => cleanupRunWorktrees(s.store, run.id), /ownership/);
    assert.equal(s.git("status", "--porcelain"), s.ownerStatus);
    writeJson(descriptor, resource);
    fs.mkdirSync(workspace);
    fs.writeFileSync(
      path.join(workspace, "partial-checkout"),
      "interrupted creation",
    );
    cleanupRunWorktrees(s.store, run.id);
    assert(!fs.existsSync(workspace));
  } finally {
    await host?.close();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("cleanup refuses a live attempt and a redirected workspace", async () => {
  const s = setup();
  try {
    const run = s.store.create(
      s.definition,
      [],
      { context: "Review" },
      "guards",
      "test-fixture",
      undefined,
      false,
      {
        paths: { WORKFLOW_DATA: s.data },
        allowedFolders: [s.repository, s.data],
      },
    );
    const attempt = path.join(s.store.directory(run.id), "attempts", "prepare");
    fs.mkdirSync(attempt, { recursive: true });
    const workspace = s.register(attempt, run.id);
    writeJson(path.join(attempt, "launch.json"), { pending: true });
    assert.throws(
      () => cleanupRunWorktrees(s.store, run.id),
      /outcome is unknown/,
    );
    assert(fs.existsSync(workspace));
    fs.unlinkSync(path.join(attempt, "launch.json"));
    writeJson(path.join(attempt, "wrapper.json"), {
      pid: process.pid,
      identity: processIdentity(process.pid),
    });
    assert.throws(() => cleanupRunWorktrees(s.store, run.id), /still active/);
    fs.unlinkSync(path.join(attempt, "wrapper.json"));
    s.git("worktree", "remove", "--force", workspace);
    fs.symlinkSync(s.repository, workspace, "junction");
    assert.throws(() => cleanupRunWorktrees(s.store, run.id), /path changed/);
    fs.unlinkSync(workspace);
    fs.symlinkSync(path.join(s.root, "missing"), workspace, "junction");
    assert.throws(() => cleanupRunWorktrees(s.store, run.id), /path changed/);
    assert.equal(s.git("status", "--porcelain"), s.ownerStatus);
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});

test("cleanup removes Git registration even when the owned directory disappeared", () => {
  const s = setup();
  try {
    const run = s.store.create(
      s.definition,
      [],
      { context: "Review" },
      "missing",
      "test-fixture",
      undefined,
      false,
      {
        paths: { WORKFLOW_DATA: s.data },
        allowedFolders: [s.repository, s.data],
      },
    );
    const attempt = path.join(s.store.directory(run.id), "attempts", "prepare");
    fs.mkdirSync(attempt, { recursive: true });
    const workspace = s.register(attempt, run.id);
    fs.rmSync(path.dirname(workspace), { recursive: true });
    cleanupRunWorktrees(s.store, run.id);
    assert.deepEqual(
      s
        .git("worktree", "list", "--porcelain", "-z")
        .split("\0")
        .filter((field) => field.startsWith("worktree "))
        .map((field) =>
          fs.realpathSync.native(field.slice("worktree ".length)),
        ),
      [fs.realpathSync.native(s.repository)],
    );
    assert.equal(
      s.git(
        "for-each-ref",
        "--format=%(refname)",
        `refs/heads/strand/${s.definition.id}/${run.id}`,
      ),
      "",
    );
  } finally {
    fs.rmSync(s.root, { recursive: true, force: true });
  }
});
