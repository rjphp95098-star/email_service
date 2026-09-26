import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor(private readonly configService: ConfigService) {
    const secret = this.configService.get<string>('CRYPTO_SECRET');

    if (!secret) {
      throw new Error('CRYPTO_SECRET is missing');
    }

    /**
     * Create a strong 32-byte key using SHA-256
     * AES-256 requires exactly 32 bytes
     */
    this.key = crypto
      .createHash('sha256')
      .update(secret)
      .digest();
  }

  /**
   * Encrypt plain text
   * Returns format:
   * iv:encryptedData
   */
  encrypt(text: string): string {
    try {
      if (!text) {
        throw new Error('Text is required for encryption');
      }

      /**
       * Generate random 16-byte IV
       */
      const iv = crypto.randomBytes(16);

      /**
       * Create cipher
       */
      const cipher = crypto.createCipheriv(
        'aes-256-ctr',
        this.key,
        iv,
      );

      /**
       * Encrypt text
       */
      const encrypted = Buffer.concat([
        cipher.update(text, 'utf8'),
        cipher.final(),
      ]);

      /**
       * Return:
       * iv:encryptedText
       */
      return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
    } catch (error) {
      console.error('Encryption failed:', error);

      throw new Error('Encryption failed');
    }
  }

  /**
   * Decrypt encrypted text
   * Expected format:
   * iv:encryptedData
   */
  decrypt(text: string): string {
    try {
      if (!text) {
        throw new Error('Encrypted text is required');
      }

      /**
       * Validate format
       */
      if (!text.includes(':')) {
        throw new Error(
          'Invalid encrypted text format. Expected iv:encryptedData',
        );
      }

      /**
       * Split IV and encrypted data
       */
      const [ivHex, encryptedHex] = text.split(':');

      if (!ivHex || !encryptedHex) {
        throw new Error('Invalid IV or encrypted data');
      }

      /**
       * Convert hex back to buffers
       */
      const iv = Buffer.from(ivHex, 'hex');
      const encryptedText = Buffer.from(encryptedHex, 'hex');

      /**
       * Validate IV length
       * AES requires 16-byte IV
       */
      if (iv.length !== 16) {
        throw new Error('Invalid IV length');
      }

      /**
       * Create decipher
       */
      const decipher = crypto.createDecipheriv(
        'aes-256-ctr',
        this.key,
        iv,
      );

      /**
       * Decrypt
       */
      const decrypted = Buffer.concat([
        decipher.update(encryptedText),
        decipher.final(),
      ]);

      /**
       * Convert buffer -> utf8 string
       */
      return decrypted.toString('utf8');
    } catch (error) {
      console.error('Decryption failed:', error);

      throw new Error('Decryption failed');
    }
  }
}