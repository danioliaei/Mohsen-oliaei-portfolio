import type { Ref } from "react";
import { motion } from "motion/react";

const TAGS = ["BIM", "Software", "AEC", "Consulting"];
const ease = [0.22, 1, 0.36, 1] as const;

interface FooterProps {
  /** Container ref — RoadStage drives its opacity imperatively per frame. */
  ref?: Ref<HTMLElement>;
}

export default function Footer({ ref }: FooterProps) {
  return (
    <footer ref={ref}>
      {TAGS.map((t, i) => (
        <motion.span
          key={t}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease, delay: 0.5 + i * 0.08 }}
        >
          {t}
        </motion.span>
      ))}
    </footer>
  );
}
