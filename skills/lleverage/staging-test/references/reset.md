# Resetting staging to main (approved only)

Tier 3. Run this only in a task whose brief says Tom approved a staging reset for
the named ticket. That approval covers one reset, to `origin/main` as it is when
the task runs. Without it, request the reset instead (SKILL.md, "Requesting a
reset").

Nothing on staging may be lost, so the old head is saved first, and the push is
leased to that exact head, so it fails rather than overwrite a push that landed
in between.

1. Plan as usual: `scripts/staging-plan.sh --pr <PR> --wait 30`. A `defer`
   verdict still defers (a freeze or a busy staging outranks the approval).
   Write down `staging=` as OLD and `main=` as MAIN.
2. Save the old head as a tag. Staging's Cloud Build triggers match only
   `^staging$`, so a tag builds nothing:

   ```bash
   TAG="staging-backup/$(date -u +%Y%m%d-%H%M)-${OLD:0:12}"
   git push origin "$OLD:refs/tags/$TAG"
   git ls-remote origin "refs/tags/$TAG"
   ```

   The last command must print OLD. If it doesn't, stop here and defer: never
   reset without a verified backup.
3. Build the new head: `origin/main` with the change merged in.

   ```bash
   WT="$(mktemp -d)/staging"
   git worktree add --detach "$WT" "$MAIN"
   git -C "$WT" merge --no-ff -m "Staging: test <TICKET> (#<PR>) at <change short>" <change>
   ```

   The change merges cleanly into main (the plan checked it), so this can't
   conflict.
4. Push it, leased to OLD, as a command of its own:

   ```bash
   git -C "$WT" push --force-with-lease=staging:"$OLD" origin HEAD:refs/heads/staging
   ```

   If the lease fails, someone pushed meanwhile: keep the tag, go back to
   step 1, and treat the new head as busy staging.
5. Comment on the ticket straight away, before testing: the reset, OLD, the new
   head, the backup tag, and the commits the reset took off staging
   (`git log --oneline --no-merges "$MAIN..$OLD"`, at most ten lines and a
   count). Anyone who needs them back can merge the tag.
6. Continue with SKILL.md Step 4 (builds and rollout), Step 5 and Step 6.

Backup tags are never deleted by an agent.
