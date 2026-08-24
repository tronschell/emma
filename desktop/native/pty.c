#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <unistd.h>
#include <util.h>

#define RESIZE_FD 3
#define BUFFER_BYTES 65536
#define RESIZE_LINE_BYTES 64

static int master = -1;

static void write_all(int fd, const char *bytes, size_t count) {
  while (count > 0) {
    ssize_t wrote = write(fd, bytes, count);
    if (wrote > 0) {
      bytes += wrote;
      count -= (size_t)wrote;
      continue;
    }
    if (wrote < 0 && errno == EINTR) continue;
    return;
  }
}

static void apply_size(int columns, int rows) {
  if (columns < 1 || rows < 1 || columns > 4096 || rows > 4096) return;
  struct winsize size = { .ws_col = (unsigned short)columns, .ws_row = (unsigned short)rows };
  ioctl(master, TIOCSWINSZ, &size);
}

static size_t take_sizes(char *held, size_t length) {
  char *line = held;
  for (;;) {
    char *end = memchr(line, '\n', (size_t)(held + length - line));
    if (!end) break;
    *end = 0;
    int columns = 0, rows = 0;
    if (sscanf(line, "%d %d", &columns, &rows) == 2) apply_size(columns, rows);
    line = end + 1;
  }
  size_t rest = (size_t)(held + length - line);
  memmove(held, line, rest);
  return rest;
}

static int relay(pid_t child) {
  signal(SIGPIPE, SIG_IGN);
  struct pollfd watch[3] = {
    { .fd = STDIN_FILENO, .events = POLLIN, .revents = 0 },
    { .fd = master, .events = POLLIN, .revents = 0 },
    { .fd = fcntl(RESIZE_FD, F_GETFD) < 0 ? -1 : RESIZE_FD, .events = POLLIN, .revents = 0 },
  };
  char buffer[BUFFER_BYTES];
  char sizes[RESIZE_LINE_BYTES];
  size_t held = 0;
  for (;;) {
    if (poll(watch, 3, -1) < 0) {
      if (errno == EINTR) continue;
      break;
    }
    if (watch[1].revents) {
      ssize_t got = read(master, buffer, sizeof buffer);
      if (got <= 0) break;
      write_all(STDOUT_FILENO, buffer, (size_t)got);
      continue;
    }
    if (watch[0].revents) {
      ssize_t got = read(STDIN_FILENO, buffer, sizeof buffer);
      if (got > 0) write_all(master, buffer, (size_t)got);
      else watch[0].fd = -1;
    }
    if (watch[2].revents) {
      ssize_t got = read(RESIZE_FD, sizes + held, sizeof sizes - held);
      if (got > 0) held = take_sizes(sizes, held + (size_t)got);
      else watch[2].fd = -1;
      if (held == sizeof sizes) held = 0;
    }
  }
  int status = 0;
  while (waitpid(child, &status, 0) < 0 && errno == EINTR) continue;
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}

static int self_test(void) {
  struct winsize size = { .ws_col = 40, .ws_row = 10 };
  int fd = -1;
  pid_t child = forkpty(&fd, NULL, NULL, &size);
  if (child < 0) return 1;
  if (child == 0) {
    execlp("/bin/sh", "sh", "-c", "stty size", NULL);
    _exit(127);
  }
  char seen[256];
  size_t held = 0;
  ssize_t got;
  while (held < sizeof seen - 1 && (got = read(fd, seen + held, sizeof seen - 1 - held)) > 0) held += (size_t)got;
  seen[held] = 0;
  int status = 0;
  waitpid(child, &status, 0);
  if (strstr(seen, "10 40")) return 0;
  fprintf(stderr, "emma-pty self-test: expected \"10 40\", saw %s", seen);
  return 1;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--self-test") == 0) return self_test();
  if (argc < 4) {
    fprintf(stderr, "usage: emma-pty <columns> <rows> <command> [argument...]\n");
    return 2;
  }
  struct winsize size = { .ws_col = 80, .ws_row = 24 };
  int columns = atoi(argv[1]);
  int rows = atoi(argv[2]);
  if (columns > 0 && columns <= 4096) size.ws_col = (unsigned short)columns;
  if (rows > 0 && rows <= 4096) size.ws_row = (unsigned short)rows;
  pid_t child = forkpty(&master, NULL, NULL, &size);
  if (child < 0) {
    perror("forkpty");
    return 1;
  }
  if (child == 0) {
    execvp(argv[3], &argv[3]);
    _exit(127);
  }
  return relay(child);
}
