/* eslint-disable @typescript-eslint/no-unsafe-call */
import {
  Body,
  ConflictException,
  Controller,
  Get,
  InternalServerErrorException,
  Post,
} from '@nestjs/common';

import { Company } from '../../db/models/Company';
import {
  Ticket,
  TicketCategory,
  TicketStatus,
  TicketType,
} from '../../db/models/Ticket';
import { User, UserRole } from '../../db/models/User';
import { Op } from 'sequelize';

interface newTicketDto {
  type: TicketType;
  companyId: number;
}

interface TicketDto {
  id: number;
  type: TicketType;
  companyId: number;
  assigneeId: number;
  status: TicketStatus;
  category: TicketCategory;
}

@Controller('api/v1/tickets')
export class TicketsController {
  @Get()
  async findAll() {
    return await Ticket.findAll({ include: [Company, User] });
  }

  @Post()
  async create(@Body() newTicketDto: newTicketDto) {
    const { type, companyId } = newTicketDto;
    const category = this.getTicketCategory(type);
    const userRole = this.getUserRole(type);

    if (type === TicketType.registrationAddressChange) {
      const openCount = await Ticket.count({
        where: {
          companyId,
          category: TicketCategory.corporate,
          type: TicketType.registrationAddressChange,
          status: TicketStatus.open,
        },
      });
      if (openCount >= 1) {
        throw new ConflictException(
          `Duplicate error creating ticket: ${category} already exists for company ${companyId}`,
        );
      }
    }

    let assignee = await User.findOne({
      where: { companyId, role: userRole },
      order: [['createdAt', 'DESC']],
    });

    if (!assignee && type === TicketType.registrationAddressChange) {
      const directors = await User.count({
        where: { companyId, role: UserRole.director },
      });

      if (directors > 1) {
        throw new ConflictException(
          `Multiple users with role ${UserRole.director}. Cannot create a ticket`,
        );
      }
      assignee = await User.findOne({
        where: { companyId, role: UserRole.director },
        order: [['createdAt', 'DESC']],
      });
    }

    if (!assignee)
      throw new ConflictException(
        `Cannot find user with role ${userRole} to create a ticket`,
      );

    if (userRole === UserRole.corporateSecretary) {
      const csCount = await User.count({
        where: { companyId, role: UserRole.corporateSecretary },
      });
      if (csCount > 1) {
        throw new ConflictException(
          `Multiple users with role ${userRole}. Cannot create a ticket.`,
        );
      }
    }

    try {
      const ticket = await Ticket.create({
        companyId,
        assigneeId: assignee.id,
        category,
        type,
        status: TicketStatus.open,
      });

      if (type === TicketType.strikeOff) {
        this.resolveOtherTickets(companyId, ticket.id);
      }

      const ticketDto: TicketDto = {
        id: ticket.id,
        type: ticket.type,
        assigneeId: ticket.assigneeId,
        status: ticket.status,
        category: ticket.category,
        companyId: ticket.companyId,
      };

      return ticketDto;
    } catch (error) {
      throw new InternalServerErrorException(String(error));
    }
  }

  private getTicketCategory(type: TicketType): TicketCategory {
    switch (type) {
      case TicketType.managementReport:
        return TicketCategory.accounting;
      case TicketType.registrationAddressChange:
        return TicketCategory.corporate;
      case TicketType.strikeOff:
        return TicketCategory.management;
      default:
        return TicketCategory.accounting;
    }
  }

  private getUserRole(type: TicketType): UserRole {
    switch (type) {
      case TicketType.managementReport:
        return UserRole.accountant;
      case TicketType.registrationAddressChange:
        return UserRole.corporateSecretary;
      case TicketType.strikeOff:
        return UserRole.director;
      default:
        return UserRole.accountant;
    }
  }

  private resolveOtherTickets(companyId: number, ticketId: number) {
    void Ticket.update(
      { status: TicketStatus.resolved },
      {
        where: {
          companyId,
          status: TicketStatus.open,
          id: { [Op.ne]: ticketId },
        },
      },
    );
  }
}
