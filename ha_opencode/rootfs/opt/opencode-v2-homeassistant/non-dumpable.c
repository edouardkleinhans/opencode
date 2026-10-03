#define _GNU_SOURCE

#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#define SECRET_LENGTH 64

/* The broker handoff happens once, before JavaScript starts. Keep the MCP
 * credential in this preloaded library for the lifetime of that process, not
 * in an FD that a plugin activation can consume/close and the runtime can reuse.
 * Local plugin modules may be re-evaluated; this native state is not reloaded.
 */
static char caller_secret[SECRET_LENGTH];
static pid_t caller_owner = 0;

int opencode_v2_copy_caller_secret(char *output, int length) {
  /* A forked child must not gain access to the parent's retained credential.
   * After exec, a fresh library has no credential without broker approval.
   */
  if (caller_owner == 0 || caller_owner != getpid() ||
      output == NULL || length != SECRET_LENGTH) return 0;
  memcpy(output, caller_secret, SECRET_LENGTH);
  return SECRET_LENGTH;
}

static void fail(void) {
  _exit(126);
}

static void read_exact(int fd, void *buffer, size_t length) {
  char *cursor = buffer;
  while (length > 0) {
    ssize_t count = read(fd, cursor, length);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) fail();
    cursor += count;
    length -= (size_t)count;
  }
}

static void require_hex(const char value[SECRET_LENGTH]) {
  for (size_t index = 0; index < SECRET_LENGTH; index++) {
    if (!((value[index] >= '0' && value[index] <= '9') ||
          (value[index] >= 'a' && value[index] <= 'f'))) {
      fail();
    }
  }
}

__attribute__((constructor)) static void harden_process(void) {
  struct rlimit no_core = {0, 0};
  if (setrlimit(RLIMIT_CORE, &no_core) != 0 ||
      prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) fail();

  const char *path = getenv("OPENCODE_V2_CREDENTIAL_SOCKET");
  if (!path) {
    unsetenv("LD_PRELOAD");
    return;
  }
  if (path[0] != '/') fail();
  int broker = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (broker < 0) fail();
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  memcpy(address.sun_path, path, strlen(path) + 1);
  if (connect(broker, (struct sockaddr *)&address, sizeof(address)) != 0) fail();

  char password[SECRET_LENGTH + 1];
  char sidecar[SECRET_LENGTH];
  unsigned char has_sidecar;
  read_exact(broker, password, SECRET_LENGTH);
  read_exact(broker, &has_sidecar, sizeof(has_sidecar));
  if (has_sidecar > 1) fail();
  if (has_sidecar) read_exact(broker, sidecar, SECRET_LENGTH);
  close(broker);
  require_hex(password);
  if (has_sidecar) require_hex(sidecar);
  password[SECRET_LENGTH] = '\0';
  if (setenv("OPENCODE_SERVER_PASSWORD", password, 1) != 0) fail();
  explicit_bzero(password, sizeof(password));

  if (has_sidecar) {
    memcpy(caller_secret, sidecar, SECRET_LENGTH);
    caller_owner = getpid();
  }
  explicit_bzero(sidecar, sizeof(sidecar));
  unsetenv("OPENCODE_V2_CREDENTIAL_SOCKET");
  unsetenv("LD_PRELOAD");
}
