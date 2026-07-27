import {useEffect, type ReactNode} from "react";
import OriginalNavbarLayout from "@theme-original/Navbar/Layout";

export interface NavbarLayoutProps {
  readonly children: ReactNode;
}

export default function NavbarLayout({children}: NavbarLayoutProps) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented || event.repeat) return;
      const openNavbar = document.querySelector<HTMLElement>(
        ".navbar.navbar-sidebar--show",
      );
      if (openNavbar === null) return;
      const closeButton = openNavbar.querySelector<HTMLButtonElement>(
        "button.navbar-sidebar__close",
      );
      const toggleButton = openNavbar.querySelector<HTMLButtonElement>(
        "button.navbar__toggle",
      );
      if (closeButton === null || toggleButton === null) return;
      event.preventDefault();
      closeButton.click();
      requestAnimationFrame(() => toggleButton.focus());
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, []);

  return <OriginalNavbarLayout>{children}</OriginalNavbarLayout>;
}
