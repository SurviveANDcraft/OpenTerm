/** Phosphor glyphs used by Threads mode (regular weight unless noted), as raw
 *  SVG so only these land in the bundle. CSS colours them via currentColor. */
import fileText from "@phosphor-icons/core/regular/file-text.svg?raw";
import pencilLine from "@phosphor-icons/core/regular/pencil-simple-line.svg?raw";
import filePlus from "@phosphor-icons/core/regular/file-plus.svg?raw";
import terminal from "@phosphor-icons/core/regular/terminal.svg?raw";
import terminalWindow from "@phosphor-icons/core/regular/terminal-window.svg?raw";
import search from "@phosphor-icons/core/regular/magnifying-glass.svg?raw";
import folderOpen from "@phosphor-icons/core/regular/folder-open.svg?raw";
import globe from "@phosphor-icons/core/regular/globe-simple.svg?raw";
import robot from "@phosphor-icons/core/regular/robot.svg?raw";
import tree from "@phosphor-icons/core/regular/tree-structure.svg?raw";
import listChecks from "@phosphor-icons/core/regular/list-checks.svg?raw";
import question from "@phosphor-icons/core/regular/question.svg?raw";
import map from "@phosphor-icons/core/regular/map-trifold.svg?raw";
import puzzle from "@phosphor-icons/core/regular/puzzle-piece.svg?raw";
import lightning from "@phosphor-icons/core/regular/lightning.svg?raw";
import brain from "@phosphor-icons/core/regular/brain.svg?raw";
import wrench from "@phosphor-icons/core/regular/wrench.svg?raw";
import check from "@phosphor-icons/core/bold/check-bold.svg?raw";
import x from "@phosphor-icons/core/regular/x.svg?raw";
import warning from "@phosphor-icons/core/fill/warning-circle-fill.svg?raw";
import caretRight from "@phosphor-icons/core/bold/caret-right-bold.svg?raw";
import caretDown from "@phosphor-icons/core/regular/caret-down.svg?raw";
import arrowUp from "@phosphor-icons/core/bold/arrow-up-bold.svg?raw";
import stop from "@phosphor-icons/core/fill/stop-fill.svg?raw";
import plus from "@phosphor-icons/core/regular/plus.svg?raw";
import gitBranch from "@phosphor-icons/core/regular/git-branch.svg?raw";
import folder from "@phosphor-icons/core/regular/folder-simple.svg?raw";
import copy from "@phosphor-icons/core/regular/copy.svg?raw";
import external from "@phosphor-icons/core/regular/arrow-square-out.svg?raw";
import sparkle from "@phosphor-icons/core/regular/sparkle.svg?raw";
import dots from "@phosphor-icons/core/bold/dots-three-bold.svg?raw";
import pin from "@phosphor-icons/core/regular/push-pin.svg?raw";
import pinFill from "@phosphor-icons/core/fill/push-pin-fill.svg?raw";
import archive from "@phosphor-icons/core/regular/archive.svg?raw";
import trash from "@phosphor-icons/core/regular/trash.svg?raw";
import pencil from "@phosphor-icons/core/regular/pencil-simple.svg?raw";
import image from "@phosphor-icons/core/regular/image.svg?raw";
import paperclip from "@phosphor-icons/core/regular/paperclip.svg?raw";
import clock from "@phosphor-icons/core/regular/clock.svg?raw";
import chart from "@phosphor-icons/core/regular/chart-bar.svg?raw";
import squares from "@phosphor-icons/core/regular/squares-four.svg?raw";
import squaresFill from "@phosphor-icons/core/fill/squares-four-fill.svg?raw";
import chats from "@phosphor-icons/core/regular/chats-circle.svg?raw";
import chatsFill from "@phosphor-icons/core/fill/chats-circle-fill.svg?raw";
import shield from "@phosphor-icons/core/regular/shield-check.svg?raw";
import hand from "@phosphor-icons/core/regular/hand.svg?raw";
import files from "@phosphor-icons/core/regular/files.svg?raw";
import gitDiff from "@phosphor-icons/core/regular/git-diff.svg?raw";
import sliders from "@phosphor-icons/core/regular/sliders-horizontal.svg?raw";
import refresh from "@phosphor-icons/core/regular/arrows-clockwise.svg?raw";
import sidebar from "@phosphor-icons/core/regular/sidebar-simple.svg?raw";
import compass from "@phosphor-icons/core/regular/compass.svg?raw";
import binoculars from "@phosphor-icons/core/regular/binoculars.svg?raw";
import flow from "@phosphor-icons/core/regular/flow-arrow.svg?raw";
import cube from "@phosphor-icons/core/regular/cube.svg?raw";
import eye from "@phosphor-icons/core/regular/eye.svg?raw";
import circleDashed from "@phosphor-icons/core/regular/circle-dashed.svg?raw";
import checkCircle from "@phosphor-icons/core/fill/check-circle-fill.svg?raw";
import xCircle from "@phosphor-icons/core/fill/x-circle-fill.svg?raw";
import arrowLeft from "@phosphor-icons/core/regular/arrow-bend-up-left.svg?raw";
import coins from "@phosphor-icons/core/regular/coins.svg?raw";
import arrowsOut from "@phosphor-icons/core/regular/arrows-out-simple.svg?raw";
import eyeSlash from "@phosphor-icons/core/regular/eye-slash.svg?raw";

const RAW = {
  fileText,
  pencilLine,
  filePlus,
  terminal,
  terminalWindow,
  search,
  folderOpen,
  globe,
  robot,
  tree,
  listChecks,
  question,
  map,
  puzzle,
  lightning,
  brain,
  wrench,
  check,
  x,
  warning,
  caretRight,
  caretDown,
  arrowUp,
  stop,
  plus,
  gitBranch,
  folder,
  copy,
  external,
  sparkle,
  dots,
  pin,
  pinFill,
  archive,
  trash,
  pencil,
  image,
  paperclip,
  clock,
  chart,
  squares,
  squaresFill,
  chats,
  chatsFill,
  shield,
  hand,
  files,
  gitDiff,
  sliders,
  refresh,
  sidebar,
  compass,
  binoculars,
  flow,
  cube,
  eye,
  circleDashed,
  checkCircle,
  xCircle,
  arrowLeft,
  coins,
  arrowsOut,
  eyeSlash,
};

export type IconName = keyof typeof RAW;

export function ic(name: IconName, size = 14): string {
  return RAW[name].replace("<svg ", `<svg width="${size}" height="${size}" aria-hidden="true" focusable="false" `);
}
