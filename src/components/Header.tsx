import { motion } from "motion/react";

const NAV = [
  // Home = the spinning globe of lines & letters; CV = the mountain it assembles
  // into. RidgelineStage listens for these two hashes and morphs between the views.
  { label: "Home", href: "#home" },
  { label: "CV", href: "#cv" },
  { label: "Projects", href: "#projects" },
  { label: "About", href: "#about" },
  { label: "Contact", href: "#contact" },
];

const ease = [0.22, 1, 0.36, 1] as const;

export default function Header() {
  return (
    <motion.header
      initial={{ opacity: 0, y: -18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.9, ease, delay: 0.1 }}
    >
      <a
        className="wordmark"
        href="https://www.linkedin.com/in/daniol/"
        target="_blank"
        rel="noopener"
      >
        Mohsèn Oliaei
      </a>
      <nav>
        {NAV.map((item, i) => (
          <motion.a
            key={item.href}
            href={item.href}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease, delay: 0.35 + i * 0.08 }}
          >
            {item.label}
          </motion.a>
        ))}
      </nav>
    </motion.header>
  );
}
