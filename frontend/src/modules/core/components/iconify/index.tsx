// Adapted from SPHERE frontend/src/modules/core/components/iconify/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the mdi names SPHERE references but never registered (account-plus, information, folder-shared,
// file-replace, bell) are added; TypeScript types instead of prop-types; the icon is hidden from assistive technology.

import { forwardRef, type ReactElement, type RefAttributes } from 'react';
import {
  MdOutlineGroup,
  MdOpenInNew,
  MdGroupAdd,
  MdPersonOutline,
  MdPersonRemove,
  MdPersonSearch,
  MdArrowBack,
  MdNotificationsActive,
  MdNotificationsOff,
  MdNotificationsNone,
  MdCalendarToday,
  MdCheck,
  MdCheckCircleOutline,
  MdExpandMore,
  MdChevronRight,
  MdClose,
  MdContentCopy,
  MdDomain,
  MdFolderOff,
  MdAccountTree,
  MdInbox,
  MdLink,
  MdLinkOff,
  MdAddLink,
  MdAutorenew,
  MdLockOutline,
  MdLogout,
  MdAdd,
  MdAddCircleOutline,
  MdEdit,
  MdPhotoCamera,
  MdSend,
  MdVerifiedUser,
  MdSecurity,
  MdLabelOff,
  MdLabelOutline,
  MdOutlineFolder,
  MdOutlineDashboard,
  MdDelete,
  MdVpnKey,
  MdOutlineRemoveRedEye,
  MdOutlineShield,
  MdNorthWest,
  MdMailOutline,
  MdArrowUpward,
  MdArrowDownward,
  MdArrowRight,
  MdFormatIndentIncrease,
  MdFormatIndentDecrease,
  MdSearch,
  MdCheckBox,
  MdCheckBoxOutlineBlank,
  MdUndo,
  MdRedo,
  MdDragIndicator,
  MdSubdirectoryArrowRight,
  MdDataObject,
  MdMoreHoriz,
  MdDevices,
  MdPersonAdd,
  MdInfoOutline,
  MdFolderShared,
  MdFindReplace,
  MdNotifications,
  MdSearchOff,
  MdPlayCircleOutline,
  MdInsertChartOutlined,
  MdTune,
  MdSave,
} from 'react-icons/md';
import { TbBinaryTree2, TbCurrencyDollar } from 'react-icons/tb';
import { FaCrown, FaMicrosoft, FaShareAlt, FaWhatsapp } from 'react-icons/fa';
import type { IconType } from 'react-icons';

/** Three dots joining into one, left to right: Tabler's binary tree turned on its side. */
const ThreeIntoOne: IconType = props => (
  <TbBinaryTree2 {...props} style={{ ...props.style, transform: 'rotate(90deg)' }} />
);

const iconMap: Record<string, IconType> = {
  'mdi:account-group-outline': MdOutlineGroup,
  'mdi:account-plus-outline': MdGroupAdd,
  'mdi:account-outline': MdPersonOutline,
  'mdi:account-remove-outline': MdPersonRemove,
  'mdi:account-search': MdPersonSearch,
  'mdi:arrow-left': MdArrowBack,
  'mdi:arrow-up-left': MdNorthWest,
  'mdi:bell-badge-outline': MdNotificationsActive,
  'mdi:bell-off': MdNotificationsOff,
  'mdi:bell-outline': MdNotificationsNone,
  'mdi:calendar-outline': MdCalendarToday,
  'mdi:check': MdCheck,
  'mdi:check-circle-outline': MdCheckCircleOutline,
  'mdi:chevron-down': MdExpandMore,
  'mdi:chevron-right': MdChevronRight,
  'mdi:close': MdClose,
  'mdi:content-copy': MdContentCopy,
  'mdi:crown-outline': FaCrown,
  'mdi:email-outline': MdMailOutline,
  'mdi:microsoft-teams': FaMicrosoft,
  'mdi:share-variant': FaShareAlt,
  'mdi:whatsapp': FaWhatsapp,
  'mdi:domain': MdDomain,
  'mdi:folder-off-outline': MdFolderOff,
  'mdi:graph-outline': MdAccountTree,
  'mdi:inbox': MdInbox,
  'mdi:link': MdLink,
  'mdi:link-off': MdLinkOff,
  'mdi:link-plus': MdAddLink,
  'mdi:link-variant-off': MdLinkOff,
  'mdi:loading': MdAutorenew,
  'mdi:lock-outline': MdLockOutline,
  'mdi:logout': MdLogout,
  'mdi:plus': MdAdd,
  'mdi:plus-circle-outline': MdAddCircleOutline,
  'mdi:pencil-outline': MdEdit,
  'mdi:camera-outline': MdPhotoCamera,
  'mdi:send': MdSend,
  'mdi:shield-check-outline': MdVerifiedUser,
  'mdi:shield-lock-outline': MdSecurity,
  'mdi:tag-off-outline': MdLabelOff,
  'mdi:tag-outline': MdLabelOutline,
  'mdi:folder-outline': MdOutlineFolder,
  'mdi:link-variant': MdLink,
  'mdi:trash-can-outline': MdDelete,
  'mdi:view-dashboard-outline': MdOutlineDashboard,
  'mdi:key': MdVpnKey,
  'mdi:eye-outline': MdOutlineRemoveRedEye,
  'mdi:shield-account-outline': MdOutlineShield,
  'mdi:arrow-up': MdArrowUpward,
  'mdi:arrow-down': MdArrowDownward,
  'mdi:menu-right': MdArrowRight,
  'mdi:format-indent-increase': MdFormatIndentIncrease,
  'mdi:format-indent-decrease': MdFormatIndentDecrease,
  'mdi:magnify': MdSearch,
  'mdi:checkbox-marked': MdCheckBox,
  'mdi:checkbox-blank-outline': MdCheckBoxOutlineBlank,
  'mdi:file-tree-outline': MdAccountTree,
  'mdi:link-variant-plus': MdAddLink,
  'mdi:undo': MdUndo,
  'mdi:redo': MdRedo,
  'mdi:drag-vertical': MdDragIndicator,
  'mdi:subdirectory-arrow-right': MdSubdirectoryArrowRight,
  'mdi:code-braces': MdDataObject,
  'mdi:dots-horizontal': MdMoreHoriz,
  'mdi:devices': MdDevices,
  'tabler:currency-dollar': TbCurrencyDollar,
  'tabler:binary-tree-2-right': ThreeIntoOne,
  'mdi:open-in-new': MdOpenInNew,
  // Names SPHERE's toasts use without registering them.
  'mdi:account-plus': MdPersonAdd,
  'mdi:information': MdInfoOutline,
  'mdi:folder-shared': MdFolderShared,
  'mdi:file-replace': MdFindReplace,
  'mdi:bell': MdNotifications,
  // Names OpenBinding's ported screens use.
  'mdi:magnify-close': MdSearchOff,
  'mdi:play-circle-outline': MdPlayCircleOutline,
  'mdi:chart-box-outline': MdInsertChartOutlined,
  'mdi:tune-variant': MdTune,
  'mdi:content-save-outline': MdSave,
};

type IconifyProps = {
  icon: ReactElement | string;
  width?: number;
  color?: string;
  className?: string;
} & RefAttributes<HTMLSpanElement>;

const Iconify = forwardRef<HTMLSpanElement, IconifyProps>(
  ({ icon, width = 20, color, className, ...other }, ref) => {
    const iconName = icon as string;
    const IconComponent = iconMap[iconName];

    if (!IconComponent) {
      console.warn(`Icon not found: ${iconName}`);
      return null;
    }

    return (
      <span
        ref={ref}
        className={`component-iconify inline-flex ${className ?? ''}`}
        aria-hidden="true"
        {...other}
      >
        <IconComponent size={width} color={color} />
      </span>
    );
  }
);

Iconify.displayName = 'Iconify';

export default Iconify;
