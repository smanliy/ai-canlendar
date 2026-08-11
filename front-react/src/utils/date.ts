import dayjs, { Dayjs } from 'dayjs';
import 'dayjs/locale/zh-cn';

dayjs.locale('zh-cn');

export const formatHeaderDate = (date: string | Date | Dayjs) => dayjs(date).format('YYYY年M月D日 dddd');

export const formatTimeRange = (startTime: string, endTime: string) =>
  `${dayjs(startTime).format('HH:mm')} - ${dayjs(endTime).format('HH:mm')}`;

export const isSameDay = (date: string, target: string | Date | Dayjs) => dayjs(date).isSame(dayjs(target), 'day');

export const toIso = (date: Dayjs | string | Date) => dayjs(date).toISOString();
