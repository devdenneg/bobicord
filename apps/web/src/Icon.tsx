import type { SvgIconComponent } from '@mui/icons-material';
import MicRounded from '@mui/icons-material/MicRounded';
import MicOffRounded from '@mui/icons-material/MicOffRounded';
import HeadsetRounded from '@mui/icons-material/HeadsetRounded';
import HeadsetOffRounded from '@mui/icons-material/HeadsetOffRounded';
import ScreenShareRounded from '@mui/icons-material/ScreenShareRounded';
import StopScreenShareRounded from '@mui/icons-material/StopScreenShareRounded';
import TagRounded from '@mui/icons-material/TagRounded';
import VolumeUpRounded from '@mui/icons-material/VolumeUpRounded';
import GroupRounded from '@mui/icons-material/GroupRounded';
import ChatRounded from '@mui/icons-material/ChatRounded';
import SettingsRounded from '@mui/icons-material/SettingsRounded';
import HomeRounded from '@mui/icons-material/HomeRounded';
import InfoRounded from '@mui/icons-material/InfoRounded';
import LogoutRounded from '@mui/icons-material/LogoutRounded';
import LinkRounded from '@mui/icons-material/LinkRounded';
import AddRounded from '@mui/icons-material/AddRounded';
import SendRounded from '@mui/icons-material/SendRounded';
import EmojiEmotionsRounded from '@mui/icons-material/EmojiEmotionsRounded';
import VisibilityRounded from '@mui/icons-material/VisibilityRounded';
import VisibilityOffRounded from '@mui/icons-material/VisibilityOffRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import FullscreenRounded from '@mui/icons-material/FullscreenRounded';
import PictureInPictureAltRounded from '@mui/icons-material/PictureInPictureAltRounded';
import VideocamRounded from '@mui/icons-material/VideocamRounded';
import CheckRounded from '@mui/icons-material/CheckRounded';
import WarningRounded from '@mui/icons-material/WarningRounded';
import ImageRounded from '@mui/icons-material/ImageRounded';
import KeyboardArrowDownRounded from '@mui/icons-material/KeyboardArrowDownRounded';
import VolumeOffRounded from '@mui/icons-material/VolumeOffRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import PaletteRounded from '@mui/icons-material/PaletteRounded';
import DownloadRounded from '@mui/icons-material/DownloadRounded';
import ReplyRounded from '@mui/icons-material/ReplyRounded';
import DeleteRounded from '@mui/icons-material/DeleteRounded';
import EditRounded from '@mui/icons-material/EditRounded';
import KeyboardRounded from '@mui/icons-material/KeyboardRounded';
import NotificationsRounded from '@mui/icons-material/NotificationsRounded';
import ShieldRounded from '@mui/icons-material/ShieldRounded';
import BadgeRounded from '@mui/icons-material/BadgeRounded';

const MAP: Record<string, SvgIconComponent> = {
  mic: MicRounded, 'mic-sm': MicRounded, 'mic-off': MicOffRounded,
  head: HeadsetRounded, 'head-off': HeadsetOffRounded,
  screen: ScreenShareRounded, 'screen-stop': StopScreenShareRounded,
  hash: TagRounded, speaker: VolumeUpRounded, users: GroupRounded,
  chat: ChatRounded, gear: SettingsRounded, home: HomeRounded,
  info: InfoRounded, leave: LogoutRounded, link: LinkRounded,
  plus: AddRounded, send: SendRounded, smile: EmojiEmotionsRounded,
  eye: VisibilityRounded, cam: VideocamRounded, check: CheckRounded,
  warn: WarningRounded, image: ImageRounded,
  chevron: KeyboardArrowDownRounded, 'volume-off': VolumeOffRounded, close: CloseRounded,
  'eye-off': VisibilityOffRounded, refresh: RefreshRounded,
  fullscreen: FullscreenRounded, pip: PictureInPictureAltRounded,
  palette: PaletteRounded, download: DownloadRounded, reply: ReplyRounded,
  trash: DeleteRounded, edit: EditRounded, keyboard: KeyboardRounded,
  bell: NotificationsRounded, shield: ShieldRounded, badge: BadgeRounded,
};

export function Icon({ name, sm }: { name: string; sm?: boolean }) {
  const C = MAP[name] || InfoRounded;
  return <C className={'ic' + (sm ? ' sm' : '')} />;
}

// спрайт больше не нужен — MUI-иконки инлайнятся как компоненты
export function IconSprite() { return null; }
