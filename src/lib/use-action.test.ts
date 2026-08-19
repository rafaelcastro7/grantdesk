import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useAction } from "./use-action";

describe("useAction", () => {
  it("marks itself busy with the action's key while it runs", async () => {
    const { result } = renderHook(() => useAction());
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    let running: Promise<void>;
    act(() => {
      running = result.current.run("save", async () => {
        await blocked;
      });
    });
    expect(result.current.busy).toBe("save");

    await act(async () => {
      release();
      await running;
    });
    expect(result.current.busy).toBeNull();
  });

  it("shows what the action returned", async () => {
    const { result } = renderHook(() => useAction());
    await act(async () => {
      await result.current.run("save", async () => "Profile saved.");
    });
    expect(result.current.note).toBe("Profile saved.");
    expect(result.current.error).toBeNull();
  });

  it("turns a throw into a readable error, never [object Object]", async () => {
    // Supabase rejects with a plain object rather than an Error.
    const { result } = renderHook(() => useAction());
    await act(async () => {
      await result.current.run("save", async () => {
        throw { message: "duplicate key value violates unique constraint" };
      });
    });
    expect(result.current.error).toContain("duplicate key");
    expect(result.current.error).not.toContain("[object Object]");
  });

  it("clears the previous note before running, not after", async () => {
    // The drift this hook exists to stop: a stale "Profile saved." sitting
    // next to a fresh list of blockers, because one handler forgot this line.
    const { result } = renderHook(() => useAction());
    await act(async () => {
      await result.current.run("first", async () => "Profile saved.");
    });
    expect(result.current.note).toBe("Profile saved.");

    await act(async () => {
      await result.current.run("second", async () => {
        expect(result.current.note).toBeNull();
      });
    });
    expect(result.current.note).toBeNull();
  });

  it("clears a previous error when the next action succeeds", async () => {
    const { result } = renderHook(() => useAction());
    await act(async () => {
      await result.current.run("first", async () => {
        throw new Error("upstream is down");
      });
    });
    expect(result.current.error).toBe("upstream is down");

    await act(async () => {
      await result.current.run("second", async () => "Done.");
    });
    expect(result.current.error).toBeNull();
  });

  it("stops being busy even when the action throws", async () => {
    const { result } = renderHook(() => useAction());
    await act(async () => {
      await result.current.run("save", async () => {
        throw new Error("nope");
      });
    });
    // Otherwise every button on the screen stays disabled after one failure.
    expect(result.current.busy).toBeNull();
  });
});
