import { useEffect, useMemo, useRef, useState } from "react";
import { VineEvent } from "./TodayVineTimeline";
const MAIN_START_Y = 30;
const MAIN_END_Y = 570;
const Y_TOTAL_RANGE = MAIN_END_Y - MAIN_START_Y;
const MAIN_GROW_DURATION = 900;

type RawVine = {
  id: string;
  startY: number;
  endY: number;
  path: string;
  color: string;
  event: VineEvent;
};

type ActivatedVine<T extends RawVine> = T & { activated: boolean };

function withInactiveState<T extends RawVine>(
  vines: T[],
): Array<ActivatedVine<T>> {
  return vines.map((vine) => ({
    ...vine,
    activated: false,
  }));
}

export function useVineGrowProgress<T extends RawVine>(originVines: T[]) {
  const mainVineRef = useRef<SVGPathElement>(null);
  const [vineList, setVineList] = useState<Array<ActivatedVine<T>>>(() =>
    withInactiveState(originVines),
  );
  const vineSignature = useMemo(
    () =>
      originVines
        .map((vine: T, index) =>
          [
            index,
            vine.id ?? "",
            vine.startY,
            vine.endY,
            vine.path,
            vine.color,
            vine.event?.id ?? "",
            vine.event?.title ?? "",
            vine.event?.startTime ?? "",
            vine.event?.endTime ?? "",
            vine.event?.status ?? "",
          ].join(":"),
        )
        .join("|"),
    [originVines],
  );

  useEffect(() => {
    setVineList(withInactiveState(originVines));
  }, [vineSignature]);

  useEffect(() => {
    const mainPath = mainVineRef.current;

    if (!mainPath || vineList.length === 0) {
      return;
    }

    let rafId = 0;
    const startTime = performance.now();

    const frameTick = () => {
      const growPercent = Math.min(
        Math.max((performance.now() - startTime) / MAIN_GROW_DURATION, 0),
        1,
      );
      const currentY = MAIN_START_Y + growPercent * Y_TOTAL_RANGE;

      setVineList((prev) => {
        let changed = false;

        const next = prev.map((vine) => {
          if (vine.activated) {
            return vine;
          }

          if (vine.startY <= currentY) {
            changed = true;
            return { ...vine, activated: true };
          }

          return vine;
        });

        return changed ? next : prev;
      });

      if (growPercent < 1) {
        rafId = requestAnimationFrame(frameTick);
      }
    };

    rafId = requestAnimationFrame(frameTick);

    return () => cancelAnimationFrame(rafId);
  }, [vineSignature, vineList.length]);

  return {
    mainVineRef,
    vineList,
  };
}
