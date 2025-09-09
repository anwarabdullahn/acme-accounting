import {
  Table,
  Column,
  Model,
  BelongsTo,
  ForeignKey,
  PrimaryKey,
  AutoIncrement,
} from 'sequelize-typescript';
import { Company } from './Company';

export enum UserRole {
  accountant = 'accountant',
  corporateSecretary = 'corporateSecretary',
  director = 'director',
}

@Table({ tableName: 'users' })
export class User extends Model {
  @AutoIncrement
  @PrimaryKey
  @Column
  declare id: number;

  @Column
  declare name: string;

  @Column
  declare role: UserRole;

  @ForeignKey(() => Company)
  declare companyId: number;

  @BelongsTo(() => Company)
  company: Company;
}
