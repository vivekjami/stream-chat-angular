import { Injectable } from '@angular/core';
import { createUriFromBlob, isImageFile } from './file-utils';
import {
  BehaviorSubject,
  combineLatest,
  map,
  Observable,
  shareReplay,
  take,
} from 'rxjs';
import { AppSettings, Attachment } from 'stream-chat';
import { ChannelService } from './channel.service';
import { isImageAttachment } from './is-image-attachment';
import { NotificationService } from './notification.service';
import { AttachmentUpload, AudioRecording } from './types';
import { ChatClientService } from './chat-client.service';
import { MessageService } from './message.service';

/**
 * The `AttachmentService` manages the uploads of a message input.
 *
 * You can read more about [uploads](/chat/docs/javascript/file_uploads/) in the Stream API documentation. You can use Stream's API or the dashboard to customize the [file](/chat/docs/javascript/app_setting_overview/#file-uploads) and [image upload](/chat/docs/javascript/app_setting_overview/#image-uploads) configuration.
 */
@Injectable({
  providedIn: 'root',
})
export class AttachmentService {
  /**
   * Emits the number of uploads in progress.
   *
   * You can increment and decrement this counter if you're using custom attachments and want to disable message sending until all attachments are uploaded.
   *
   * The SDK will handle updating this counter for built-in attachments, but for custom attachments you should take care of this.
   */
  attachmentUploadInProgressCounter$ = new BehaviorSubject<number>(0);
  /**
   * Emits the state of the uploads ([`AttachmentUpload[]`](https://github.com/GetStream/stream-chat-angular/blob/master/projects/stream-chat-angular/src/lib/types.ts)), it adds a state (`success`, `error` or `uploading`) to each file the user selects for upload. It is used by the [`AttachmentPreviewList`](/chat/docs/sdk/angular/components/AttachmentPreviewListComponent/) to display the attachment previews.
   */
  attachmentUploads$: Observable<AttachmentUpload[]>;
  /**
   * You can get and set the list if uploaded custom attachments
   *
   * By default the SDK components won't display these, but you can provide your own `customAttachmentPreviewListTemplate$` and `customAttachmentListTemplate$` for the [`CustomTemplatesService`](/chat/docs/sdk/angular/services/CustomTemplatesService/).
   */
  customAttachments$ = new BehaviorSubject<Attachment[]>([]);
  /**
   * The current number of attachments
   */
  attachmentsCounter$: Observable<number>;
  /**
   * The maximum number of attachments allowed for a message.
   *
   * The maximum is 30, you can set it to lower, but not higher.
   */
  maxNumberOfAttachments = 30;
  private attachmentUploadsSubject = new BehaviorSubject<AttachmentUpload[]>(
    []
  );
  private appSettings: AppSettings | undefined;
  private attachmentLimitNotificationHide?: () => void;

  constructor(
    private channelService: ChannelService,
    private notificationService: NotificationService,
    private chatClientService: ChatClientService,
    private messageService: MessageService
  ) {
    this.attachmentUploads$ = this.attachmentUploadsSubject.asObservable();
    this.chatClientService.appSettings$.subscribe(
      (appSettings) => (this.appSettings = appSettings)
    );
    this.attachmentsCounter$ = combineLatest([
      this.attachmentUploads$,
      this.customAttachments$,
    ]).pipe(
      map(([attchmentUploads, customAttachments]) => {
        return (
          attchmentUploads.filter((u) => u.state === 'success').length +
          customAttachments.length
        );
      }),
      shareReplay(1)
    );
    this.attachmentsCounter$.subscribe((count) => {
      if (count > this.maxNumberOfAttachments) {
        this.attachmentLimitNotificationHide =
          this.notificationService.addPermanentNotification(
            'streamChat.You currently have {{count}} attachments, the maximum is {{max}}',
            'error',
            { count, max: this.maxNumberOfAttachments }
          );
      } else {
        this.attachmentLimitNotificationHide?.();
      }
    });
  }

  /**
   * Resets the attachments uploads (for example after the message with the attachments sent successfully)
   */
  resetAttachmentUploads() {
    this.attachmentUploadsSubject.next([]);
    this.customAttachments$.next([]);
    this.attachmentLimitNotificationHide?.();
  }

  /**
   * Upload a voice recording
   * @param audioRecording
   * @returns A promise with true or false. If false is returned the upload was canceled because of a client side error. The error is emitted via the `NotificationService`.
   */
  async uploadVoiceRecording(audioRecording: AudioRecording) {
    if (!this.isWithinLimit(1)) {
      return false;
    }
    if (
      !(await this.areAttachmentsHaveValidExtension([audioRecording.recording]))
    ) {
      return false;
    }
    if (!(await this.areAttachmentsHaveValidSize([audioRecording.recording]))) {
      return false;
    }

    const upload = {
      file: audioRecording.recording,
      previewUri: audioRecording.asset_url,
      extraData: {
        duration: audioRecording.duration,
        waveform_data: audioRecording.waveform_data,
      },
      state: 'uploading' as const,
      type: 'voiceRecording' as const,
    };
    this.attachmentUploadsSubject.next([
      ...this.attachmentUploadsSubject.getValue(),
      upload,
    ]);
    await this.uploadAttachments([upload]);
    return true;
  }

  /**
   * Uploads the selected files, and creates preview for image files. The result is propagated throught the `attachmentUploads$` stream.
   * @param fileList The files selected by the user, if you have Blobs instead of Files, you can convert them with this method: https://developer.mozilla.org/en-US/docs/Web/API/File/File
   * @returns A promise with true or false. If false is returned the upload was canceled because of a client side error. The error is emitted via the `NotificationService`.
   */
  async filesSelected(fileList: FileList | File[] | null) {
    if (!fileList) {
      return;
    }

    const files = Array.from(fileList);

    if (!this.isWithinLimit(files.length)) {
      return false;
    }

    if (!(await this.areAttachmentsHaveValidExtension(files))) {
      return false;
    }
    if (!(await this.areAttachmentsHaveValidSize(files))) {
      return false;
    }
    const imageFiles: File[] = [];
    const dataFiles: File[] = [];
    const videoFiles: File[] = [];

    files.forEach((file) => {
      if (isImageFile(file)) {
        imageFiles.push(file);
      } else if (file.type.startsWith('video/')) {
        videoFiles.push(file);
      } else {
        dataFiles.push(file);
      }
    });
    imageFiles.forEach((f) => void this.createPreview(f));
    const newUploads = [
      ...imageFiles.map((file) => ({
        file,
        state: 'uploading' as const,
        type: 'image' as const,
      })),
      ...videoFiles.map((file) => ({
        file,
        state: 'uploading' as const,
        type: 'video' as const,
      })),
      ...dataFiles.map((file) => ({
        file,
        state: 'uploading' as const,
        type: 'file' as const,
      })),
    ];
    this.attachmentUploadsSubject.next([
      ...this.attachmentUploadsSubject.getValue(),
      ...newUploads,
    ]);
    await this.uploadAttachments(newUploads);
    return true;
  }

  /**
   * You can add custom `image`, `video` and `file` attachments using this method.
   *
   * Note: If you just want to use your own CDN for file uploads, you don't necessary need this method, you can just specify you own upload function in the [`ChannelService`](/chat/docs/sdk/angular/services/ChannelService/)
   * @param attachment
   *
   * Will set `isCustomAttachment` to `true` on the attachment. This is a non-standard field, other SDKs will ignore this property.
   */
  addAttachment(attachment: Attachment) {
    attachment.isCustomAttachment = true;
    this.createFromAttachments([attachment]);
  }

  /**
   * Retries to upload an attachment.
   * @param file
   * @returns A promise with the result
   */
  async retryAttachmentUpload(file: File) {
    const attachmentUploads = this.attachmentUploadsSubject.getValue();
    const upload = attachmentUploads.find((u) => u.file === file);
    if (!upload) {
      return;
    }
    upload.state = 'uploading';
    this.attachmentUploadsSubject.next([...attachmentUploads]);
    await this.uploadAttachments([upload]);
  }

  /**
   * Deletes an attachment, the attachment can have any state (`error`, `uploading` or `success`).
   * @param upload
   */
  async deleteAttachment(upload: AttachmentUpload) {
    const attachmentUploads = this.attachmentUploadsSubject.getValue();
    let result!: AttachmentUpload[];
    if (
      upload.state === 'success' &&
      !upload.fromAttachment?.isCustomAttachment
    ) {
      try {
        await this.channelService.deleteAttachment(upload);
        result = [...attachmentUploads];
        const index = attachmentUploads.indexOf(upload);
        result.splice(index, 1);
      } catch (error) {
        result = attachmentUploads;
        this.notificationService.addTemporaryNotification(
          'streamChat.Error deleting attachment'
        );
      }
    } else {
      result = [...attachmentUploads];
      const index = attachmentUploads.indexOf(upload);
      result.splice(index, 1);
    }
    this.attachmentUploadsSubject.next([...result]);
  }

  /**
   * Maps the current uploads to a format that can be sent along with the message to the Stream API.
   * @returns the attachments
   */
  mapToAttachments() {
    const attachmentUploads = this.attachmentUploadsSubject.getValue();
    const builtInAttachments = attachmentUploads
      .filter((r) => r.state === 'success')
      .map((r) => {
        let attachment: Attachment = {
          type: r.type,
        };
        if (r.fromAttachment) {
          return r.fromAttachment;
        } else {
          attachment.mime_type = r.file?.type;
          if (r.type === 'image') {
            attachment.fallback = r.file?.name;
            attachment.image_url = r.url;
          } else {
            attachment.asset_url = r.url;
            attachment.title = r.file?.name;
            attachment.file_size = r.file?.size;
            attachment.thumb_url = r.thumb_url;
          }
          if (r.extraData) {
            attachment = { ...attachment, ...r.extraData };
          }
        }

        return attachment;
      });
    return [...builtInAttachments, ...this.customAttachments$.value];
  }

  /**
   * Maps attachments received from the Stream API to uploads. This is useful when editing a message.
   * @param attachments Attachemnts received with the message
   */
  createFromAttachments(attachments: Attachment[]) {
    const attachmentUploads: AttachmentUpload[] = [];
    const builtInAttachments: Attachment[] = [];
    const customAttachments: Attachment[] = [];
    attachments.forEach((attachment) => {
      if (this.messageService.isCustomAttachment(attachment)) {
        customAttachments.push(attachment);
      } else {
        builtInAttachments.push(attachment);
      }
    });
    builtInAttachments.forEach((attachment) => {
      if (isImageAttachment(attachment)) {
        attachmentUploads.push({
          url: (attachment.img_url ||
            attachment.thumb_url ||
            attachment.image_url) as string,
          state: 'success',
          type: 'image',
          file: {
            name: attachment.fallback,
            type: attachment.mime_type,
          } as File,
          fromAttachment: attachment,
        });
      } else if (attachment.type === 'file' || attachment.type === 'video') {
        attachmentUploads.push({
          url: attachment.asset_url,
          state: 'success',
          file: {
            name: attachment.title,
            size: attachment.file_size,
            type: attachment.mime_type,
          } as File,
          type: attachment.type,
          thumb_url: attachment.thumb_url,
          fromAttachment: attachment,
        });
      } else if (attachment.type === 'voiceRecording') {
        attachmentUploads.push({
          url: attachment.asset_url,
          state: 'success',
          file: {
            name: attachment.title,
            size: attachment.file_size,
            type: attachment.mime_type,
          } as File,
          type: 'voiceRecording',
          extraData: {
            duration: attachment.duration,
            waveform_data: attachment.waveform_data,
          },
        });
      }
    });

    if (attachmentUploads.length > 0) {
      this.attachmentUploadsSubject.next([
        ...this.attachmentUploadsSubject.getValue(),
        ...attachmentUploads,
      ]);
    }

    if (customAttachments.length > 0) {
      this.customAttachments$.next(customAttachments);
    }
  }

  private async createPreview(file: File | Blob) {
    try {
      const uri = await createUriFromBlob(file);
      const attachmentUploads = this.attachmentUploadsSubject.getValue();
      const upload = attachmentUploads.find((upload) => upload.file === file);
      if (!upload) {
        return;
      }
      upload.previewUri = uri;
      this.attachmentUploadsSubject.next([...attachmentUploads]);
    } catch (e: unknown) {
      this.chatClientService?.chatClient?.logger(
        'error',
        e instanceof Error ? e.message : `Can't create image preview`,
        { error: e, tag: ['AttachmentService'] }
      );
    }
  }

  private async uploadAttachments(uploads: AttachmentUpload[]) {
    this.attachmentUploadInProgressCounter$.next(
      this.attachmentUploadInProgressCounter$.value + 1
    );
    const result = await this.channelService.uploadAttachments(uploads);
    const attachmentUploads = this.attachmentUploadsSubject.getValue();
    result.forEach((r) => {
      const upload = attachmentUploads.find((upload) => upload.file === r.file);
      if (!upload) {
        if (r.url) {
          void this.channelService.deleteAttachment(r);
        }
        return;
      }
      upload.state = r.state;
      upload.url = r.url;
      upload.thumb_url = r.thumb_url;
      if (upload.state === 'error') {
        upload.errorReason = r.errorReason;
        upload.errorExtraInfo = r.errorExtraInfo;
        let errorKey;
        const translateParams: { name: string; ext?: string; limit?: string } =
          { name: upload.file.name };
        switch (upload.errorReason) {
          case 'file-extension':
            errorKey =
              'streamChat.Error uploading file, extension not supported';
            translateParams.ext = upload.errorExtraInfo?.[0]?.param;
            break;
          case 'file-size':
            errorKey =
              'streamChat.Error uploading file, maximum file size exceeded';
            translateParams.limit = upload.errorExtraInfo?.[0]?.param;
            break;
          default:
            errorKey = 'streamChat.Error uploading file';
        }
        this.notificationService.addTemporaryNotification(
          errorKey,
          'error',
          undefined,
          translateParams
        );
      }
    });
    this.attachmentUploadInProgressCounter$.next(
      this.attachmentUploadInProgressCounter$.value - 1
    );
    this.attachmentUploadsSubject.next([...attachmentUploads]);
  }

  private async areAttachmentsHaveValidExtension(files: File[]) {
    if (!this.appSettings) {
      try {
        await this.chatClientService.getAppSettings();
      } catch (error) {
        return true;
      }
    }
    let isValid = true;
    files.forEach((f) => {
      let hasBlockedExtension: boolean;
      let hasBlockedMimeType: boolean;
      let hasNotAllowedExtension: boolean;
      let hasNotAllowedMimeType: boolean;
      if (isImageFile(f)) {
        hasBlockedExtension =
          !!this.appSettings?.image_upload_config?.blocked_file_extensions?.find(
            (ext) => f.name.endsWith(ext)
          );
        hasBlockedMimeType =
          !!this.appSettings?.image_upload_config?.blocked_mime_types?.find(
            (type) => f.type === type
          );
        hasNotAllowedExtension =
          !!this.appSettings?.image_upload_config?.allowed_file_extensions
            ?.length &&
          !this.appSettings?.image_upload_config?.allowed_file_extensions?.find(
            (ext) => f.name.endsWith(ext)
          );
        hasNotAllowedMimeType =
          !!this.appSettings?.image_upload_config?.allowed_mime_types?.length &&
          !this.appSettings?.image_upload_config?.allowed_mime_types?.find(
            (type) => f.type === type
          );
      } else {
        hasBlockedExtension =
          !!this.appSettings?.file_upload_config?.blocked_file_extensions?.find(
            (ext) => f.name.endsWith(ext)
          );
        hasBlockedMimeType =
          !!this.appSettings?.file_upload_config?.blocked_mime_types?.find(
            (type) => f.type === type
          );
        hasNotAllowedExtension =
          !!this.appSettings?.file_upload_config?.allowed_file_extensions
            ?.length &&
          !this.appSettings?.file_upload_config?.allowed_file_extensions?.find(
            (ext) => f.name.endsWith(ext)
          );
        hasNotAllowedMimeType =
          !!this.appSettings?.file_upload_config?.allowed_mime_types?.length &&
          !this.appSettings?.file_upload_config?.allowed_mime_types?.find(
            (type) => f.type === type
          );
      }
      if (
        hasBlockedExtension ||
        hasBlockedMimeType ||
        hasNotAllowedExtension ||
        hasNotAllowedMimeType
      ) {
        this.notificationService.addTemporaryNotification(
          'streamChat.Error uploading file, extension not supported',
          undefined,
          undefined,
          { name: f.name, ext: f.type }
        );
        isValid = false;
      }
    });
    return isValid;
  }

  private async areAttachmentsHaveValidSize(files: File[]) {
    if (!this.appSettings) {
      try {
        await this.chatClientService.getAppSettings();
      } catch (error) {
        return true;
      }
    }
    const imageSizeLimitInBytes =
      this.appSettings?.image_upload_config?.size_limit || 0;
    const imageSizeLimiString = `${imageSizeLimitInBytes / (1024 * 1024)}MB`;
    const fileSizeLimitInBytes =
      this.appSettings?.file_upload_config?.size_limit || 0;
    const fileSizeLimitInString = `${fileSizeLimitInBytes / (1024 * 1024)}MB`;
    let isValid = true;
    files.forEach((f) => {
      let isOverSized = false;
      let limit = '';
      if (isImageFile(f) && imageSizeLimitInBytes > 0) {
        isOverSized = f.size > imageSizeLimitInBytes;
        limit = imageSizeLimiString;
      } else if (fileSizeLimitInBytes > 0) {
        isOverSized = f.size > fileSizeLimitInBytes;
        limit = fileSizeLimitInString;
      }
      if (isOverSized) {
        this.notificationService.addTemporaryNotification(
          'streamChat.Error uploading file, maximum file size exceeded',
          undefined,
          undefined,
          { name: f.name, limit: limit }
        );
        isValid = false;
      }
    });
    return isValid;
  }

  private isWithinLimit(numberOfNewAttachments: number) {
    let currentNumberOfAttachments: number = 0;
    this.attachmentsCounter$
      .pipe(take(1))
      .subscribe((counter) => (currentNumberOfAttachments = counter));
    if (
      currentNumberOfAttachments + numberOfNewAttachments >
      this.maxNumberOfAttachments
    ) {
      this.notificationService.addTemporaryNotification(
        `streamChat.You can't uplod more than {{max}} attachments`,
        'error',
        undefined,
        { max: this.maxNumberOfAttachments }
      );
      return false;
    } else {
      return true;
    }
  }
}
