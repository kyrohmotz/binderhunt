#!/usr/bin/env python3
"""Workflow contracts for Pages deploys.

The live site only updates when a deploy step succeeds. Data commits are
pushed with the workflow token, which does not start pages.yml, so the
inline deploy is the publish path for prices and the Daily Drop.
"""
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
ACTION = ROOT / ".github" / "actions" / "deploy-pages" / "action.yml"
RESULT = ROOT / "scripts" / "pages_deploy_result.sh"
CHECKOUT = ROOT / "scripts" / "pages_checkout_main.sh"


def load_yaml(path):
    with path.open(encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def job_text(path, job_name):
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    start = None
    for index, line in enumerate(lines):
        if line.startswith(f"  {job_name}:"):
            start = index
            break
    if start is None:
        raise AssertionError(f"{path} has no job {job_name}")
    end = len(lines)
    for index in range(start + 1, len(lines)):
        if lines[index].startswith("  ") and not lines[index].startswith("   ") and lines[index].strip().endswith(":"):
            end = index
            break
    return "".join(lines[start:end])


class PagesDeployWorkflowTests(unittest.TestCase):
    def test_shared_pages_group_does_not_cancel(self):
        pages = load_yaml(WORKFLOWS / "pages.yml")
        daily = load_yaml(WORKFLOWS / "daily.yml")
        scrydex = load_yaml(WORKFLOWS / "scrydex.yml")
        demand = (WORKFLOWS / "scrydex-demand.yml").read_text(encoding="utf-8")

        self.assertEqual(pages["concurrency"]["group"], "pages")
        self.assertIs(pages["concurrency"]["cancel-in-progress"], False)
        self.assertEqual(daily["jobs"]["deploy"]["concurrency"]["group"], "pages")
        self.assertIs(daily["jobs"]["deploy"]["concurrency"]["cancel-in-progress"], False)
        self.assertEqual(scrydex["jobs"]["deploy"]["concurrency"]["group"], "pages")
        self.assertIs(scrydex["jobs"]["deploy"]["concurrency"]["cancel-in-progress"], False)

        # The data jobs keep their own queues. Moving those groups onto
        # `pages` would hold the deploy lock during the Scrydex calls.
        self.assertEqual(scrydex["concurrency"]["group"], "scrydex-cache")
        self.assertIs(scrydex["concurrency"]["cancel-in-progress"], False)
        self.assertEqual(daily["concurrency"]["group"], "daily-drop")
        self.assertIs(daily["concurrency"]["cancel-in-progress"], False)

        self.assertNotIn("deploy-pages", demand)
        self.assertNotIn("upload-pages-artifact", demand)
        self.assertNotIn("group: pages", demand)

    def test_deploy_retries_live_in_one_action(self):
        action = load_yaml(ACTION)
        steps = action["runs"]["steps"]
        uses = [step.get("uses", "") for step in steps]
        self.assertEqual(uses.count("actions/upload-pages-artifact@v3"), 1)
        self.assertEqual(uses.count("actions/deploy-pages@v4"), 3)
        sleeps = [step.get("run", "") for step in steps]
        self.assertIn("sleep 15", sleeps)
        self.assertIn("sleep 30", sleeps)
        publish = steps[-1]
        self.assertEqual(publish["id"], "publish")
        self.assertIn("pages_deploy_result.sh", publish["run"])
        self.assertIn("!cancelled()", publish["if"])

        for name in ("pages.yml", "daily.yml", "scrydex.yml"):
            text = (WORKFLOWS / name).read_text(encoding="utf-8")
            self.assertIn("uses: ./.github/actions/deploy-pages", text)
            self.assertNotIn("uses: actions/upload-pages-artifact@", text)
            self.assertNotIn("uses: actions/deploy-pages@", text)

    def test_data_deploys_checkout_main_and_do_not_call_scrydex(self):
        for name, job in (("daily.yml", "deploy"), ("scrydex.yml", "deploy")):
            body = job_text(WORKFLOWS / name, job)
            self.assertIn("ref: main", body)
            self.assertIn("pages_checkout_main.sh", body)
            self.assertNotIn("sync_scrydex.py", body)
            self.assertNotIn("SCRYDEX", body)
            self.assertIn("changed == 'true'", body)

        pages = (WORKFLOWS / "pages.yml").read_text(encoding="utf-8")
        self.assertIn("github.event_name == 'workflow_dispatch' && github.sha || 'main'", pages)

    def test_scrydex_spend_guards_stay(self):
        text = (WORKFLOWS / "scrydex.yml").read_text(encoding="utf-8")
        self.assertIn("SCRYDEX_MONTHLY_CAP: ${{ vars.SCRYDEX_MONTHLY_CAP || '15000' }}", text)
        self.assertIn('if [ "$GITHUB_REF" != "refs/heads/main" ]; then', text)
        self.assertIn("Refusing to spend Scrydex credits.", text)
        self.assertEqual(text.count("python3 scripts/sync_scrydex.py"), 1)
        sync = job_text(WORKFLOWS / "scrydex.yml", "sync")
        self.assertIn("environment:", sync)
        self.assertIn("name: github-pages", sync)
        self.assertIn("python3 scripts/sync_scrydex.py", sync)

    def test_result_script_accepts_a_later_success(self):
        code, output, err = self.run_result(
            OUTCOME1="failure",
            URL1="",
            OUTCOME2="success",
            URL2="https://kyrohmotz.github.io/binderhunt/",
            OUTCOME3="skipped",
            URL3="",
        )
        self.assertEqual(code, 0, err)
        self.assertEqual(output, "page_url=https://kyrohmotz.github.io/binderhunt/\n")

    def test_result_script_keeps_the_first_url(self):
        code, output, err = self.run_result(
            OUTCOME1="success",
            URL1="https://example.test/first",
            OUTCOME2="success",
            URL2="https://example.test/second",
            OUTCOME3="skipped",
            URL3="",
        )
        self.assertEqual(code, 0, err)
        self.assertEqual(output, "page_url=https://example.test/first\n")

    def test_result_script_fails_when_every_attempt_failed(self):
        code, output, err = self.run_result(
            OUTCOME1="failure",
            OUTCOME2="failure",
            OUTCOME3="failure",
        )
        self.assertEqual(code, 1)
        self.assertIn("Pages deploy failed after 3 attempts", err)
        self.assertEqual(output, "page_url=\n")

    def test_checkout_main_follows_a_newer_tip(self):
        with tempfile.TemporaryDirectory() as tmp:
            origin, work, env = self.make_repo(tmp)
            first = self.commit_file(work, env, "card.txt", "price-a\n", "prices")
            self.git("push", "origin", "main", cwd=work, env=env)
            self.commit_file(work, env, "card.txt", "price-b\n", "newer")
            self.git("push", "origin", "main", cwd=work, env=env)
            self.git("checkout", "--force", first, cwd=work, env=env)
            proc = subprocess.run(
                ["bash", str(CHECKOUT), first],
                cwd=work,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            tip = self.git("rev-parse", "HEAD", cwd=work, env=env).stdout.strip()
            self.assertNotEqual(tip, first)
            ancestor = subprocess.run(
                ["git", "merge-base", "--is-ancestor", first, "HEAD"],
                cwd=work,
                env=env,
                check=False,
            )
            self.assertEqual(ancestor.returncode, 0)
            self.assertIn(tip, proc.stdout)

    def test_checkout_main_rejects_a_commit_that_was_not_pushed(self):
        with tempfile.TemporaryDirectory() as tmp:
            origin, work, env = self.make_repo(tmp)
            self.commit_file(work, env, "card.txt", "on-main\n", "base")
            self.git("push", "origin", "main", cwd=work, env=env)
            local = self.commit_file(work, env, "card.txt", "not-pushed\n", "local only")
            env["PAGES_FETCH_DELAYS"] = "0"
            proc = subprocess.run(
                ["bash", str(CHECKOUT), local],
                cwd=work,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(proc.returncode, 1)
            self.assertIn("not on origin/main", proc.stderr)
            self.assertNotIn(origin.name, proc.stdout)

    def test_result_script_ignores_skipped_attempts(self):
        code, output, err = self.run_result(OUTCOME1="skipped", OUTCOME2="skipped", OUTCOME3="skipped")
        self.assertEqual(code, 1)
        self.assertEqual(output, "page_url=\n")
        self.assertIn("failed after 3 attempts", err)

    def git(self, *args, cwd, env):
        return subprocess.run(
            ["git", *args],
            cwd=cwd,
            env=env,
            text=True,
            capture_output=True,
            check=True,
        )

    def make_repo(self, tmp):
        origin = Path(tmp) / "origin.git"
        work = Path(tmp) / "work"
        env = os.environ.copy()
        env.update(
            {
                "GIT_AUTHOR_NAME": "BinderHunt Test",
                "GIT_AUTHOR_EMAIL": "test@example.com",
                "GIT_COMMITTER_NAME": "BinderHunt Test",
                "GIT_COMMITTER_EMAIL": "test@example.com",
            }
        )
        self.git("init", "--bare", "-b", "main", str(origin), cwd=tmp, env=env)
        self.git("init", "-b", "main", str(work), cwd=tmp, env=env)
        self.git("remote", "add", "origin", str(origin), cwd=work, env=env)
        return origin, work, env

    def commit_file(self, work, env, name, text, message):
        path = Path(work) / name
        path.write_text(text, encoding="utf-8")
        self.git("add", name, cwd=work, env=env)
        self.git("commit", "-m", message, cwd=work, env=env)
        return self.git("rev-parse", "HEAD", cwd=work, env=env).stdout.strip()

    def run_result(self, **env):
        with tempfile.TemporaryDirectory() as tmp:
            output_path = Path(tmp) / "github_output"
            output_path.touch()
            full = os.environ.copy()
            for key in list(full):
                if key.startswith("OUTCOME") or key.startswith("URL") or key == "GITHUB_OUTPUT":
                    full.pop(key)
            full["GITHUB_OUTPUT"] = str(output_path)
            full.update(env)
            proc = subprocess.run(
                ["bash", str(RESULT)],
                env=full,
                text=True,
                capture_output=True,
                check=False,
            )
            return proc.returncode, output_path.read_text(encoding="utf-8"), proc.stderr


if __name__ == "__main__":
    unittest.main()
