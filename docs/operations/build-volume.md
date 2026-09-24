# Build volume

Cauldron lane workspaces and the worktree quarantine live on a dedicated Hetzner Cloud Volume mounted at `/mnt/bdc-builds`. Build growth can fill that volume without filling hetzner-prod's root disk.

The container still sees the original paths. Host bind mounts put `/mnt/bdc-builds/workspaces` on `/opt/bdc/archon-data/workspaces` and `/mnt/bdc-builds/worktree-quarantine` on `/opt/bdc/archon-data/worktree-quarantine`. Docker bind-mounts the parent `/.archon` directory with recursive (rbind) semantics, so `archon-app-1` sees both trees at `/.archon/workspaces` and `/.archon/worktree-quarantine` after a start. Git worktree metadata stores those absolute container paths, so the paths must not change.

The two trees are separate bind mounts, not one mount of all of `/opt/bdc/archon-data`. That keeps `archon.db` and the rest of the Archon data directory on the root disk. `rename(2)` between the two mounts returns `EXDEV` even when both are ext4. `moveDirAcrossDevices` in `packages/core/src/services/worktree-sweep.ts` renames first and, only on `EXDEV`, copies then deletes. A missing volume then slows quarantine moves instead of failing the sweep. Do not cut over until the running container contains that function.

Stage B below is host work on hetzner-prod. It runs only after this change is on `dev` and `archon-app-1` has been rebuilt. Confirm first:

```bash
docker exec archon-app-1 grep -c moveDirAcrossDevices /app/packages/core/src/services/worktree-sweep.ts
```

Expected: at least 2. John creates the 100 GB volume in the Hetzner Console (location Hillsboro, server `ubuntu-8gb-hil-1`, mount Manual, filesystem ext4, name `bdc-builds`) and confirms it is attached. No other container is stopped.

## Check the volume

```bash
findmnt -no SOURCE,TARGET /mnt/bdc-builds
```

One line. SOURCE is the volume device (`/dev/sdb` or the `HC_Volume` by-id path). TARGET is `/mnt/bdc-builds`.

```bash
grep -c bdc-builds /etc/fstab
grep -E 'bdc-builds' /etc/fstab | grep -vc nofail
```

Expected after cutover: 3 fstab lines, and 0 of those lines missing `nofail`.

## Cutover

`<id>` is the numeric volume id from the Hetzner Volumes list.

1. Identify the new disk. Never run `mkfs` on `sda`.

```bash
lsblk -o NAME,SIZE,SERIAL,FSTYPE,MOUNTPOINT
ls -l /dev/disk/by-id/ | grep HC_Volume
```

If `FSTYPE` is empty:

```bash
sudo mkfs.ext4 -L bdc-builds /dev/disk/by-id/scsi-0HC_Volume_<id>
```

2. Mount `/mnt/bdc-builds`. Back up fstab first.

```bash
sudo mkdir -p /mnt/bdc-builds
sudo cp /etc/fstab /etc/fstab.pre-build-volume
```

Append:

```
/dev/disk/by-id/scsi-0HC_Volume_<id> /mnt/bdc-builds ext4 discard,nofail,defaults,x-systemd.device-timeout=30s,x-systemd.before=docker.service 0 2
```

```bash
sudo systemctl daemon-reload && sudo mount /mnt/bdc-builds
sudo mkdir -p /mnt/bdc-builds/workspaces /mnt/bdc-builds/worktree-quarantine
sudo touch /mnt/bdc-builds/.bdc-build-volume
```

3. Warm copy while the harness is still running:

```bash
sudo rsync -aHAX --numeric-ids /opt/bdc/archon-data/workspaces/ /mnt/bdc-builds/workspaces/
sudo rsync -aHAX --numeric-ids /opt/bdc/archon-data/worktree-quarantine/ /mnt/bdc-builds/worktree-quarantine/
```

4. Drain and stop the harness only. Read `ARCHON_OPERATOR_TOKEN` with `docker exec archon-app-1 printenv ARCHON_OPERATOR_TOKEN` and do not echo it. POST `{"draining":true,"reason":"WO-INFRA-HETZNER-BUILD-VOLUME-01 cutover"}` to `http://localhost:3090/api/admin/drain` with header `x-archon-operator-token`. Poll GET `/api/admin/drain` until `activeRunCount` is 0 and `drained` is true. Then:

```bash
docker stop archon-app-1
```

5. Final copy. On mismatch, stop and roll back. Do not continue.

```bash
sudo rsync -aHAX --numeric-ids --delete /opt/bdc/archon-data/workspaces/ /mnt/bdc-builds/workspaces/
sudo rsync -aHAX --numeric-ids --delete /opt/bdc/archon-data/worktree-quarantine/ /mnt/bdc-builds/worktree-quarantine/
sudo find /opt/bdc/archon-data/workspaces | wc -l
sudo find /mnt/bdc-builds/workspaces | wc -l
sudo du -sb --apparent-size /opt/bdc/archon-data/workspaces /mnt/bdc-builds/workspaces
```

Repeat the `find` and `du` pair for `worktree-quarantine`. The two counts and the two byte sizes must match for each pair.

6. Swap the directories, keep the originals, and bind-mount. `chattr +i` on the empty mountpoint directories makes a write fail when the volume is not mounted, so a missing volume cannot refill the root disk.

```bash
sudo mv /opt/bdc/archon-data/workspaces /opt/bdc/archon-data/workspaces.pre-volume
sudo mv /opt/bdc/archon-data/worktree-quarantine /opt/bdc/archon-data/worktree-quarantine.pre-volume
sudo mkdir /opt/bdc/archon-data/workspaces /opt/bdc/archon-data/worktree-quarantine
sudo chmod 777 /opt/bdc/archon-data/workspaces
sudo chmod 755 /opt/bdc/archon-data/worktree-quarantine
sudo chown 1001:1001 /opt/bdc/archon-data/workspaces /opt/bdc/archon-data/worktree-quarantine
sudo chattr +i /opt/bdc/archon-data/workspaces /opt/bdc/archon-data/worktree-quarantine
```

Append both binds to `/etc/fstab`:

```
/mnt/bdc-builds/workspaces /opt/bdc/archon-data/workspaces none bind,nofail,x-systemd.requires-mounts-for=/mnt/bdc-builds,x-systemd.before=docker.service 0 0
/mnt/bdc-builds/worktree-quarantine /opt/bdc/archon-data/worktree-quarantine none bind,nofail,x-systemd.requires-mounts-for=/mnt/bdc-builds,x-systemd.before=docker.service 0 0
```

```bash
sudo systemctl daemon-reload
sudo mount /opt/bdc/archon-data/workspaces
sudo mount /opt/bdc/archon-data/worktree-quarantine
```

7. Start the same container (do not recreate it; rbind picks up the new submounts at start). Wait for health, then clear drain with POST `{"draining":false}`.

```bash
docker start archon-app-1
curl -sf http://localhost:3090/api/health
docker exec archon-app-1 df -P /.archon/workspaces | tail -1
```

The filesystem column must be the volume device, not `/dev/sda1`, and the size about 98G. GET `/api/admin/drain` must report mode normal.

8. Prove one lane run completes after cutover (a completed row in `remote_agent_workflow_runs` with `started_at` after the cutover timestamp). `docker logs archon-app-1 --since 2h 2>&1 | grep -c EXDEV` must be 0.

9. Only after those checks pass, remove the copies left on the root disk:

```bash
sudo rm -rf /opt/bdc/archon-data/workspaces.pre-volume /opt/bdc/archon-data/worktree-quarantine.pre-volume
```

## Rollback

Until step 9, the root disk still holds `*.pre-volume`.

1. POST drain `{"draining":true}` if the container is up. Wait until drained. `docker stop archon-app-1`.
2. `sudo umount /opt/bdc/archon-data/workspaces /opt/bdc/archon-data/worktree-quarantine` and `sudo umount /mnt/bdc-builds`.
3. `sudo cp /etc/fstab.pre-build-volume /etc/fstab && sudo systemctl daemon-reload`.
4. `sudo chattr -i` on both empty directories, `sudo rmdir` them, and `sudo mv` each `*.pre-volume` directory back to its original name. If runs wrote to the volume after step 7, rsync `/mnt/bdc-builds/workspaces/` and `/mnt/bdc-builds/worktree-quarantine/` back over the `*.pre-volume` directories first so work written after cutover is not lost.
5. `docker start archon-app-1`, confirm health 200, and clear drain.

After step 9 the originals are gone. Stop the harness, rsync from `/mnt/bdc-builds/workspaces/` and `/mnt/bdc-builds/worktree-quarantine/` back onto the root paths (root disk space permitting), then follow the steps above.
