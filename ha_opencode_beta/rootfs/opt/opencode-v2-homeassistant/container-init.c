#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define SOURCE_PATH "/homeassistant"
#define READY_PATH "/run/opencode-v2-homeassistant.ready"

extern char **environ;

static _Noreturn void fail(const char *message) {
  dprintf(STDERR_FILENO, "opencode-container-init: %s: %s\n", message,
          strerror(errno));
  _exit(126);
}

static void require_directory(const char *path, uid_t uid, gid_t gid) {
  struct stat info;
  if (lstat(path, &info) != 0) {
    dprintf(STDERR_FILENO, "opencode-container-init: cannot inspect %s: %s\n",
            path, strerror(errno));
    _exit(126);
  }
  if (!S_ISDIR(info.st_mode)) {
    dprintf(STDERR_FILENO,
            "opencode-container-init: %s must be a real directory, not a symlink or file; check the Home Assistant configuration mount\n",
            path);
    _exit(126);
  }
  if (info.st_uid != uid || info.st_gid != gid) {
    dprintf(STDERR_FILENO,
            "opencode-container-init: %s has uid=%lu gid=%lu; expected uid=%lu gid=%lu; check the Home Assistant configuration mount ownership (no files were changed)\n",
            path, (unsigned long)info.st_uid, (unsigned long)info.st_gid,
            (unsigned long)uid, (unsigned long)gid);
    _exit(126);
  }
}

static void publish_ready(void) {
  int fd = open(READY_PATH,
                O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd < 0 || fchmod(fd, 0600) != 0) {
    fail("cannot publish the V2 workspace marker");
  }
  static const char value[] = SOURCE_PATH "\n";
  if (write(fd, value, sizeof(value) - 1) != (ssize_t)(sizeof(value) - 1) ||
      fsync(fd) != 0 || close(fd) != 0) {
    fail("cannot persist the V2 workspace marker");
  }
}

int main(void) {
  if (geteuid() != 0) {
    errno = EPERM;
    fail("must start as root");
  }
  require_directory(SOURCE_PATH, 0, 0);
  if (unlink(READY_PATH) != 0 && errno != ENOENT) {
    fail("cannot remove a stale V2 workspace marker");
  }
  publish_ready();

  char *arguments[] = {"/init", NULL};
  execve(arguments[0], arguments, environ);
  fail("cannot execute s6 init");
}
