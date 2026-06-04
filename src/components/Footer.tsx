import { motion } from "motion/react";

const TAGS = ["BIM", "Software", "AEC", "Consulting"];
const ease = [0.22, 1, 0.36, 1] as const;

export default function Footer() {
  return (
    <footer>
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
