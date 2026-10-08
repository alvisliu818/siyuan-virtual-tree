"""Jupyter 内核启动器(仅 Windows 中断机制需要)。

为什么要有这个文件:ipykernel 的中断不走 ZMQ(6.28 的 control 通道没有
interrupt_request,已核实),而是走 Win32 事件 —— 内核里的轮询线程等
JPY_INTERRUPT_EVENT 指向的事件,被触发就在执行线程抛 KeyboardInterrupt
(见 ipykernel/kernelapp.py:197 与 jupyter_client/win_interrupt.py)。

创建/触发 Win32 事件只有 ctypes 能做,Electron 渲染进程做不了,所以由本
启动器代劳:

  1. 创建可被继承的中断事件(bInheritHandle=1)
  2. 以 CREATE_NEW_PROCESS_GROUP 启动 ipykernel_launcher,把句柄值写进环境
  3. 监听 stdin 命令行:interrupt → SetEvent;quit → 结束内核并退出
  4. 退出码跟随内核进程,宿主据此判断内核死因

stdin 是命令通道;内核 stderr 继承本进程 stderr,宿主侧照常捕获。
POSIX 上不需要这套(直接 SIGINT 即可),宿主只在本平台拉起本文件。
"""
import ctypes
import os
import subprocess
import sys
import threading


def _create_interrupt_event() -> int:
    """与 jupyter_client/win_interrupt.py 的 create_interrupt_event 等价。"""

    class SECURITY_ATTRIBUTES(ctypes.Structure):
        _fields_ = [
            ("nLength", ctypes.c_int),
            ("lpSecurityDescriptor", ctypes.c_void_p),
            ("bInheritHandle", ctypes.c_int),
        ]

    sa = SECURITY_ATTRIBUTES()
    sa_p = ctypes.pointer(sa)
    sa.nLength = ctypes.sizeof(SECURITY_ATTRIBUTES)
    sa.lpSecurityDescriptor = 0
    sa.bInheritHandle = 1
    return int(ctypes.windll.kernel32.CreateEventA(sa_p, False, False, ""))


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: jupyter-launch.py <connection.json>", file=sys.stderr)
        sys.exit(2)
    conn_file = sys.argv[1]
    debug = bool(os.environ.get("JUPYTER_LAUNCH_DEBUG"))

    handle = _create_interrupt_event()
    env = dict(os.environ)
    env["JPY_INTERRUPT_EVENT"] = str(handle)
    # 老环境变量名,ipykernel 仍识别,双保险
    env["IPY_INTERRUPT_EVENT"] = str(handle)

    CREATE_NEW_PROCESS_GROUP = 0x00000200
    # close_fds=False 是必须的:否则事件句柄不会随子进程继承,
    # 内核里按句柄值轮询会一直等一个无效句柄,中断静默失效
    kernel = subprocess.Popen(
        [sys.executable, "-u", "-m", "ipykernel_launcher", "-f", conn_file],
        env=env,
        creationflags=CREATE_NEW_PROCESS_GROUP,
        close_fds=False,
        stdin=subprocess.PIPE,
    )
    if debug:
        print(f"[jupyter-launch] launcher_pid={os.getpid()} kernel_pid={kernel.pid} handle={handle}",
              file=sys.stderr, flush=True)

    def pump() -> None:
        try:
            for line in sys.stdin:
                cmd = line.strip()
                if cmd == "interrupt":
                    ctypes.windll.kernel32.SetEvent(handle)
                    if debug:
                        print("[jupyter-launch] interrupt event set", file=sys.stderr, flush=True)
                elif cmd == "quit":
                    break
        except Exception as e:
            if debug:
                print(f"[jupyter-launch] pump error: {e}", file=sys.stderr, flush=True)
        try:
            kernel.terminate()
        except Exception:
            pass

    watcher = threading.Thread(target=pump, daemon=True)
    watcher.start()
    try:
        rc = kernel.wait()
    finally:
        try:
            kernel.terminate()
        except Exception:
            pass
    sys.exit(rc if isinstance(rc, int) else 0)


if __name__ == "__main__":
    main()
