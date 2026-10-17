/* Synthetic namespace/mount denials only. No model, credentials or host mounts. */
#define _GNU_SOURCE
#include <sched.h>
#include <sys/mount.h>
#include <sys/wait.h>
#include <sys/prctl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int write_map(const char *path, const char *value) {
  FILE *file = fopen(path, "w");
  if (!file) return -1;
  int result = fputs(value, file) < 0 ? -1 : 0;
  if (fclose(file)) result = -1;
  return result;
}
static int child(void *opaque) {
  unsigned *ids = opaque;
  if (prctl(PR_SET_NAME, "teetime-neg", 0, 0, 0)) return 9;
  char mapping[64];
  if (write_map("/proc/self/setgroups", "deny\n")) return 10;
  snprintf(mapping, sizeof(mapping), "0 %u 1\n", ids[0]);
  if (write_map("/proc/self/uid_map", mapping)) return 11;
  snprintf(mapping, sizeof(mapping), "0 %u 1\n", ids[1]);
  if (write_map("/proc/self/gid_map", mapping)) return 12;
  if (mount(NULL, "/", NULL, MS_REC | MS_SILENT | MS_SLAVE, NULL)) return 13;
  errno = 0;
  int destination = mount("tmpfs", "/protected/negative-mount", "tmpfs", MS_NOSUID | MS_NODEV, NULL);
  int destination_errno = errno;
  if (!destination) umount2("/protected/negative-mount", MNT_DETACH);
  errno = 0;
  int options = mount("tmpfs", "/tmp", "tmpfs", MS_NOSUID | MS_NOEXEC, NULL);
  int options_errno = errno;
  if (!options) umount2("/tmp", MNT_DETACH);
  printf("{\"destinationResult\":%d,\"destinationErrno\":%d,\"optionsResult\":%d,\"optionsErrno\":%d}\n", destination, destination_errno, options, options_errno);
  fflush(stdout);
  return destination == -1 && destination_errno == EACCES && options == -1 && options_errno == EACCES ? 0 : 14;
}
int main(void) {
  unsigned ids[] = {getuid(), getgid()};
  char *stack = malloc(1024 * 1024);
  if (!stack) return 20;
  pid_t pid = clone(child, stack + 1024 * 1024, CLONE_NEWUSER | CLONE_NEWNS | SIGCHLD, ids);
  if (pid < 0) return 21;
  int status;
  if (waitpid(pid, &status, 0) < 0) return 22;
  free(stack);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 23;
}
