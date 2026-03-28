/*
    SPDX-FileCopyrightText: 2018 Eon S. Jeon <esjeon@hyunmu.am>
    SPDX-FileCopyrightText: 2024 Vjatcheslav V. Kolchkov <akl334@protonmail.ch>

    SPDX-License-Identifier: MIT
*/

class WrapperMap<F, T> {
  private items: { [key: string]: T };

  constructor(
    public readonly hasher: (item: F) => string,
    public readonly wrapper: (item: F) => T,
  ) {
    this.items = {};
  }

  public add(item: F): T {
    const key = this.hasher(item);
    if (this.has(item)) return this.items[key];
    const wrapped = this.wrapper(item);
    this.items[key] = wrapped;
    return wrapped;
  }

  public has(item: F): boolean {
    return this.items[this.hasher(item)] !== undefined;
  }

  public get(item: F): T | null {
    const key = this.hasher(item);
    return this.items[key] || null;
  }

  public getByKey(key: string): T | null {
    return this.items[key] || null;
  }

  public remove(item: F): boolean {
    const key = this.hasher(item);
    return delete this.items[key];
  }
  public length(): number {
    return Object.keys(this.items).length;
  }
}
