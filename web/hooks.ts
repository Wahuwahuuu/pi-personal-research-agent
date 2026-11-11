import { useEffect, useState } from "react";
import { api, errorText } from "./api.ts";
import type { Page } from "./types.ts";
export function useResource<T>(path: string | undefined, revision = 0) {
  const [result, setResult] = useState<{ path: string; value: T }>(),
    [failure, setFailure] = useState<{ path: string; message: string }>(),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setFailure(undefined);
    if (!path) {
      setResult(undefined);
      return;
    }
    void api<T>(path)
      .then((value) => {
        if (live) setResult({ path, value });
      })
      .catch((e) => {
        if (live) setFailure({ path, message: errorText(e) });
      });
    return () => {
      live = false;
    };
  }, [path, revision, retry]);
  return {
    value: result?.path === path ? result?.value : undefined,
    error: failure?.path === path ? (failure?.message ?? "") : "",
    reload: () => setRetry((v) => v + 1),
  };
}
export function usePaged<T>(path: string, revision = 0) {
  const [position, setPosition] = useState<{
    path: string;
    cursors: (string | number)[];
  }>({ path, cursors: [""] });
  const cursors = position.path === path ? position.cursors : [""],
    current = cursors.at(-1)!;
  const result = useResource<Page<T>>(
    path +
      (current !== ""
        ? (path.includes("?") ? "&" : "?") +
          "after=" +
          encodeURIComponent(current)
        : ""),
    revision,
  );
  return {
    ...result,
    hasPrevious: cursors.length > 1,
    pageNumber: cursors.length,
    previous: () => setPosition({ path, cursors: cursors.slice(0, -1) }),
    next: () => {
      if (result.value?.nextCursor != null)
        setPosition({ path, cursors: [...cursors, result.value.nextCursor] });
    },
  };
}
export function useRoute() {
  const read = () => {
    try {
      const parts = location.hash.slice(1).split("/");
      return {
        page: parts[0] || "chat",
        id: parts[1] ? decodeURIComponent(parts[1]) : undefined,
      };
    } catch {
      return { page: "chat", id: undefined };
    }
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const cb = () => setRoute(read());
    addEventListener("hashchange", cb);
    return () => removeEventListener("hashchange", cb);
  }, []);
  return route;
}
export function navigate(page: string, id?: string) {
  location.hash = page + (id ? "/" + encodeURIComponent(id) : "");
}
export type Run = (action: () => Promise<unknown>) => Promise<void>;
