#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define RUNTIME_UID_MIN 61000
#define RUNTIME_UID_MAX 61015
#ifndef BIN_ROOT
#define BIN_ROOT "/data/.config/opencode/bin"
#endif
#define BIN_PREFIX BIN_ROOT "/"

extern char **environ;

static _Noreturn void fail(const char *message) {
  dprintf(STDERR_FILENO, "external-mcp-launch: %s\n", message);
  _exit(126);
}

static int valid_environment_name(const char *name) {
  if (!name[0] || !((name[0] >= 'A' && name[0] <= 'Z') || name[0] == '_')) return 0;
  for (size_t i = 1; name[i]; i++) {
    if (!((name[i] >= 'A' && name[i] <= 'Z') ||
          (name[i] >= '0' && name[i] <= '9') || name[i] == '_')) return 0;
  }
  const char *reserved[] = {
      "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TMPDIR",
      "IFS", "ENV", "BASH_ENV", "NODE_OPTIONS", "NODE_PATH", NULL,
  };
  for (size_t i = 0; reserved[i]; i++) {
    if (strcmp(name, reserved[i]) == 0) return 0;
  }
  return strncmp(name, "LD_", 3) != 0 && strncmp(name, "DYLD_", 5) != 0;
}

static int open_verified_target(const char *path) {
  if (strncmp(path, BIN_PREFIX, strlen(BIN_PREFIX)) != 0) fail("target is outside the MCP bin directory");
  const char *leaf = path + strlen(BIN_PREFIX);
  if (!leaf[0] || strchr(leaf, '/')) fail("target must be directly inside the MCP bin directory");

  int directory = open(BIN_ROOT, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
  struct stat info;
  if (directory < 0 || fstat(directory, &info) != 0 || !S_ISDIR(info.st_mode) ||
      info.st_uid != 0 || info.st_gid != 0 || (info.st_mode & 07777) != 0755) {
    if (directory >= 0) close(directory);
    fail("MCP bin directory is not secured");
  }

  int target = openat(directory, leaf, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (target < 0 || fstat(target, &info) != 0 || !S_ISREG(info.st_mode) ||
      info.st_uid != 0 || info.st_gid != 0 || info.st_nlink != 1 ||
      (info.st_mode & 07777) != 0755) {
    close(directory);
    if (target >= 0) close(target);
    fail("local MCP executable is not a secured root-owned file");
  }
  if (close(directory) != 0 || fcntl(target, F_SETFD, 0) != 0) {
    close(target);
    fail("cannot pin the local MCP executable");
  }
  return target;
}

static void harden_and_drop_privileges(uid_t runtime_id) {
  struct rlimit no_core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &no_core) != 0 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 ||
      setgroups(0, NULL) != 0 ||
      setresgid(runtime_id, runtime_id, runtime_id) != 0 ||
      setresuid(runtime_id, runtime_id, runtime_id) != 0 ||
      getuid() != runtime_id || geteuid() != runtime_id ||
      getgid() != runtime_id || getegid() != runtime_id) {
    fail("cannot establish the local MCP security boundary");
  }
}

int main(int argc, char **argv) {
  if (argc < 4 || getuid() != 0 || geteuid() != 0 || getgid() != 0 || getegid() != 0) {
    fail("expected root, a runtime identity and an environment count followed by a target command");
  }

  char *end = NULL;
  errno = 0;
  long runtime_id = strtol(argv[1], &end, 10);
  if (errno != 0 || end == argv[1] || *end != '\0' || runtime_id < RUNTIME_UID_MIN ||
      runtime_id > RUNTIME_UID_MAX) {
    fail("runtime identity is invalid");
  }
  end = NULL;
  errno = 0;
  long environment_count = strtol(argv[2], &end, 10);
  if (errno != 0 || end == argv[2] || *end != '\0' || environment_count < 0 ||
      environment_count > 64 || argc < environment_count + 4) {
    fail("environment count is invalid");
  }

  char **values = calloc((size_t)environment_count, sizeof(char *));
  if (!values && environment_count) fail("cannot allocate the local MCP environment");
  for (long i = 0; i < environment_count; i++) {
    const char *name = argv[3 + i];
    const char *value = getenv(name);
    if (!valid_environment_name(name) || !value || !(values[i] = strdup(value))) {
      fail("an explicit local MCP environment value is missing or invalid");
    }
  }

  int target_index = (int)environment_count + 3;
  int target = open_verified_target(argv[target_index]);
  if (clearenv() != 0 ||
      setenv("PATH", "/usr/local/bin:/usr/bin:/bin", 1) != 0 ||
      setenv("HOME", "/tmp", 1) != 0 ||
      setenv("USER", "external-mcp", 1) != 0 ||
      setenv("LOGNAME", "external-mcp", 1) != 0 ||
      setenv("SHELL", "/usr/sbin/nologin", 1) != 0 ||
      setenv("LANG", "C.UTF-8", 1) != 0 ||
      setenv("TMPDIR", "/tmp", 1) != 0) {
    fail("cannot construct the local MCP environment");
  }
  for (long i = 0; i < environment_count; i++) {
    if (setenv(argv[3 + i], values[i], 1) != 0) fail("cannot set the local MCP environment");
    explicit_bzero(values[i], strlen(values[i]));
    free(values[i]);
  }
  free(values);

  harden_and_drop_privileges((uid_t)runtime_id);
  fexecve(target, &argv[target_index], environ);
  fail("cannot execute the local MCP server");
}
